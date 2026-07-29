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
 *       POST /net/live    LiveFanoutBody → best-effort direct-observation
 *                         delivery with no sequence or derived-state write
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
  OPERATOR_CUSTOMER_ID,
  type Principal
} from "../../net/attribution";
import { auditShardFor, mintGatewayAuditRecord } from "../../net/audit";
import { CellStore, cellKey, cellVersion, makeCell, type Cell } from "../../net/cells";
import { mintSampleDecision, spanSampled, turnSpans } from "../../net/spans";
import { exportSpans, spanSampleRate } from "./span-export";
import { adoptOrMintTraceContext, normalizeTraceContext, parseTraceparent, type TraceContext } from "../../net/trace";
import { clampClientSessionTtl } from "../../net/client-session-policy";
import { budgetExhausted, isNetError, netError, nonconvergentRead, NetError, type AttemptTraceEntry, type NetErrorCode } from "../../net/errors";
import { LIVE_FANOUT_BATCH_CAP, type LiveFanoutBatchBody, type LiveFanoutBody } from "../../net/live";
import { applyFanout, type FanoutBody } from "../../net/outbox";
import {
  observationsForRelationOwners,
  relationKey,
  roomRosterRows,
  SESSION_PRESENCE_RELATION,
  type RelationDelta,
  type RelationRow,
  type RoomRosterRow
} from "../../net/relations";
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
import { replayPageQueryKey, replayPageVersion, validReplayLogPage, validReplayPageQuery, type ReplayPageQuery } from "../../net/replay-pages";
import type { ScopeClassifier } from "../../net/route";
import { CATALOG_SCOPE, classifierFromLineage, isEpochImmutableDefinition, type AnchorLineage } from "../../net/topology";
import { assertEnvelopeCeiling, submitEnvelopeBytes, WARM_ENVELOPE_BYTE_LIMIT, type CommitReply, type CommitSubmit, type RejectReason, type ReplayOutput, type ScheduledTurn, type ScopeHead } from "../../net/scope";
import { netCellKeyFor, type EffectTranscript } from "../../net/transcript";
import type { CellTransfer } from "../../net/cells";
import { randomHex } from "../../core/source-hash";
import { parseRoutedApiKeyId, routedApiKeyScope } from "../../core/api-key-id";
import { verbAliasMatches } from "../../core/verb-name-match";
import {
  GUEST_RESET_NATIVE,
  guestResetVerbPageFor,
  guestResetVerbSlot,
  isCurrentGuestResetVerbPageFor,
  isRecognizedGuestResetVerbPageFor
} from "../../core/bootstrap";
import { turnEchoId } from "../../net/turn-echo";
// Audience rules that live inside the observation (directed / self-addressed)
// are shared with the core direct-call path so both delivery lanes agree.
import { observationReachesActor, type Observation } from "../../core/types";
import type { ShadowTurnCall } from "../../core/shadow-turn-call";
import { provisionGuestSubmit, type GuestTemplate } from "../../net/guest";
import { identityAnchorIds, provisionAnchorSubmit } from "../../net/identity-anchor";
import { verifyInternalRequest } from "../internal-auth";
import { mcpOriginDecision, PUBLIC_ORIGIN_HEADER } from "../public-origin";
import { emitMetric, type AnalyticsMetric } from "../metrics-sink";
import {
  ClientAuthError,
  MAX_EMAIL_BYTES,
  MAX_PASSWORD_BYTES,
  normalizeEmail,
  parseClientCredential,
  verifyApiKeyCredential,
  verifyApiKeyRecord,
  verifyPasswordCredential
} from "./client-auth";
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
  /** Maximum staleness of one authority-verified API-key record. Zero forces
   * an exact RPC per request. Default: 1000ms; hard-capped at 30s. */
  NET_CREDENTIAL_TTL_MS?: string;
  /** Extra browser origins admitted by the MCP `Origin` check, comma or
   * whitespace separated (e.g. a second public hostname serving the client).
   * Unset by default — the endpoint's own public origin always passes, so no
   * hostname is compiled in. See src/worker/public-origin.ts. */
  WOO_MCP_ALLOWED_ORIGINS?: string;
};

function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

type ScopeRow = { seen_seq: number };
const MAX_NET_BROWSER_METRICS_BATCH = 50;
/** Edge-audit outbox continuation (CO2.7 fresh-lineage rule): the append
 * RPC runs from the alarm event, never a request-deferred task. */
const GATEWAY_AUDIT_ALARM_KEY = "gateway:audit-drain";
const GATEWAY_AUDIT_RETRY_MS = 5_000;

/** One owner-computed ordered-children projection the gateway fetched for a
 * turn: the bounded rows plus the authority `version` (content address) the
 * plan attests so a concurrent same-parent insert makes the submit stale (P1.1). */
type OrderedChildrenProjection = { container: string; scope: string; parent: string | null; rows: readonly Record<string, unknown>[]; version: string; authority_head: ScopeHead };
type PlanningOrderedChildrenProjection = Omit<OrderedChildrenProjection, "authority_head">;

/** One owner-answered bounded neighbour query (P2.4): the O(1)
 * {count, index, before, after, child_index} answer plus the same authority
 * ordering `version` a full projection carries, so the attestation is
 * identical — only the payload shrinks from O(width) to constant. */
type OrderedNeighborsProjection = { container: string; query: OrderedNeighborsQuery; scope: string; value: Record<string, unknown>; version: string; authority_head: ScopeHead };
type PlanningOrderedNeighborsProjection = Omit<OrderedNeighborsProjection, "authority_head">;
type OrderingConflict = { scope: string; container: string; parent: string | null };

/** One owner-served committed replay page the gateway fetched for a turn
 * (sequenced-log.md SL4): the entries for one exact `(space, from, limit)`
 * window in the planning shape, plus the authority page `version` the plan
 * attests so a committed-log append inside the window makes the submit
 * stale. `space` is the SEMANTIC space id; `scope` is the owning authority
 * the page came from (routed via classifier.scopeOf(space)). */
type ReplayPageProjection = { space: string; from: number; limit: number; scope: string; entries: readonly Record<string, unknown>[]; version: string; authority_head: ScopeHead };
type PlanningReplayPageProjection = Omit<ReplayPageProjection, "authority_head">;
type ReplayConflict = { scope: string; space: string; from: number; limit: number };

function validReplayConflict(value: unknown): value is ReplayConflict {
  const conflict = value as { scope?: unknown; space?: unknown; from?: unknown; limit?: unknown } | null;
  return Boolean(
    conflict && typeof conflict === "object" &&
    typeof conflict.scope === "string" && conflict.scope.length > 0 &&
    validReplayPageQuery(conflict)
  );
}

/** One successful targeted refresh, identified by the authority's sequenced
 * head as well as the cell's content version. Only receipts backed by an
 * established owner and a mutation-complete head participate in terminal
 * non-convergence detection. */
type AuthorityReadReceipt = { scope: string; head: ScopeHead; version: string };
type AuthorityCellTransfer = CellTransfer & { scope?: unknown; head?: unknown };
function validScopeHead(value: unknown): value is ScopeHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { seq?: unknown; hash?: unknown; generation?: unknown };
  return typeof candidate.seq === "number" && Number.isInteger(candidate.seq) && candidate.seq >= 0
    && typeof candidate.hash === "string" && candidate.hash.length > 0
    && typeof candidate.generation === "number" && Number.isInteger(candidate.generation) && candidate.generation >= 0;
}

function authorityReceiptIdentity(receipt: AuthorityReadReceipt): string {
  return `${receipt.scope}\0${receipt.head.seq}\0${receipt.head.hash}\0${receipt.head.generation}\0${receipt.version}`;
}

/** Generation is mutation-complete: commits, seed, and activation all advance
 * it. A receipt with the new shape is therefore eligible even at seq zero. */
function authorityCellReceiptEligible(_key: string, head: ScopeHead): boolean {
  return head.generation !== undefined;
}

function authorityOrderingReceiptEligible(head: ScopeHead): boolean {
  return head.generation !== undefined;
}

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
  /** CO2.5: the CLIENT chose this key and expects retry semantics. Set by an
   * MCP `operation_id` and by `retry_safe:true` on /net-api/turn; NOT set
   * for a gateway-minted key, nor for the browser's per-turn ids, which are
   * unique by construction and would only add a storage write per turn. It
   * makes an effect-free but externally visible turn (speech) record a
   * receipt so its retry cannot emit the act a second time. */
  retry_receipt?: boolean;
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

/** /net/provision-wizard body (AP11; see operatorProvisionWizard). The
 * internal-signed operator op that mints a usable wizard on a deployed world.
 * Carries no credential material: the api-key id is a pointer whose verifier
 * is installed by the separate /net-operator/credentials/ensure route. */
type OperatorProvisionWizardRequest = {
  /** The existing human actor whose account anchors the new agent. */
  human: string;
  /** Opaque operator-chosen idempotency token, durable on the operator machine
   * before the first call so a lost reply replays exactly. */
  provision_id: string;
  name?: string;
  purpose?: string;
  /** Routed api-key id the operator generated locally; recorded on the agent so
   * rotate/revoke find the credential the operator holds. */
  api_key_id?: string;
  /** Report what the world holds without mutating anything. The operator's
   * only way to tell "no human" from "no primitive" before running for real. */
  probe?: boolean;
};

/** The seed identity classes an operator anchor instantiates. Named once, here,
 * rather than inside the genesis builder: the builder stays world-agnostic and
 * this is the single place the net layer states which bootstrap classes carry
 * the account/human contract. */
const ANCHOR_HUMAN_CLASS = "$human";
const ANCHOR_ACCOUNT_CLASS = "$account";

/** /net/provision-anchor body (AP11.9; see operatorProvisionAnchor). */
type OperatorProvisionAnchorRequest = {
  /** Opaque operator-chosen token; the anchor's object ids derive from it, so
   * a re-run names the same identity rather than minting a second. */
  anchor_id: string;
  label?: string;
  agent_quota?: number;
  /** Report the ids this token derives and whether they already exist, without
   * creating anything. Lets the operator's read-only probe resolve a token to
   * a human id without the probe itself seeding an identity. */
  probe?: boolean;
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
  /** Public id of the API key that authenticated this mint. The secret never
   * enters session state; bearer-only follow-up requests use this id to
   * re-check the key's current authority record. */
  apikey_id?: string;
  /** False suppresses only the public/social roster row. The session remains
   * present for authorization and fanout. */
  roster_visible?: boolean;
};

/** /net/turn reply body. `trace` lists the failed rounds that preceded
 * the final verdict (empty on a first-try accept), so callers and tests
 * can see the convergence shape (CO6). */
type TurnResult = {
  reply: CommitReply;
  selection: { scope: string; riders: string[] };
  /** Actual serialized submit RPC body bytes of the settling round,
   * measured immediately before the submit RPC (CO7). */
  envelopeBytes: number;
  attempt: number;
  trace: AttemptTraceEntry[];
  /** Phase-4 item 1: the planned transcript's verb return value,
   * error, and observations, carried on an ACCEPTED reply (the gateway
   * holds the planned transcript — every transport needs the caller to
   * see what its turn did). Omitted on rejected replies (nothing
   * committed). On a detected idempotent replay these carry the RECORDED
   * outcome of the execution that committed, never this round's re-plan
   * (see `replayed` and `replay_outcome`).
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
   * committed and is never presented as the outcome; the authority's
   * RETAINED output is (CO2.5, `replay_outcome`).
   * A replay whose re-plan converged on the identical post-state is
   * indistinguishable from (and equivalent to) a fresh accept, and
   * carries the re-planned result/observations without this flag. */
  replayed?: boolean;
  /** CO2.5: how much of the committed execution's outcome this replay is
   * able to show. `full` — result (when the verb returned one), error, and
   * observations are the recorded ones. `partial` — some part existed and
   * was not retained; `replay_omitted` names which. `none` — the authority
   * retained no outcome for this key (a reply recorded before outcome
   * retention shipped, or a key replayed by a different actor). A `none`
   * replay still proves the turn committed exactly once; the client must
   * re-read state rather than retry under a new key. Present only alongside
   * `replayed`. */
  replay_outcome?: "full" | "partial" | "none";
  /** The parts of the outcome that existed but were not retained. */
  replay_omitted?: Array<"result" | "error" | "observations">;
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
 * CO2.5: the TurnResult fields for a detected idempotent replay.
 *
 * Everything here comes from the authority's RETAINED output — the caller's
 * re-plan is never consulted, because it describes an execution that
 * committed nothing. When the authority retained no outcome (a reply
 * recorded before outcome retention shipped, a key replayed by a different
 * actor, or a payload over the retention cap) the honest answer is
 * `replay_outcome:"none"` with no result: the turn provably committed
 * exactly once, and the client must re-read state instead of retrying under
 * a fresh key. An absent result must never be reported as `null`, which a
 * client would read as "the verb returned nothing".
 */
function replayedTurnOutput(output: ReplayOutput | undefined): {
  replayed: true;
  result?: EffectTranscript["result"];
  error?: EffectTranscript["error"];
  observations?: EffectTranscript["observations"];
  replay_outcome: "full" | "partial" | "none";
  replay_omitted?: Array<"result" | "error" | "observations">;
} {
  if (output === undefined) return { replayed: true, replay_outcome: "none", observations: [] };
  const omitted = output.omitted ?? [];
  return {
    replayed: true,
    ...(output.result !== undefined ? { result: output.result } : {}),
    ...(output.error !== undefined ? { error: output.error } : {}),
    observations: output.observations ?? [],
    replay_outcome: omitted.length > 0 ? "partial" : "full",
    ...(omitted.length > 0 ? { replay_omitted: [...omitted] } : {})
  };
}

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
  /** Exact repair-loop round currently executing. Unlike trace length, this
   * stays correct for failures after the current round has already appended
   * its trace entry and for failures before a round appends one. */
  current_attempt = 0;
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
  /** Phase name paired with rpc_max_ms. Successful turns must retain the
   * same attribution that failure details provide; otherwise a deployed
   * latency tail says how long the stall was but not which authority step
   * owned it. The first zero-millisecond step wins when workerd freezes the
   * clock, so every turn still carries a bounded, known phase. */
  rpc_max_phase = "";
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
      if (this.rpc_max_phase === "" || ms > this.rpc_max_ms) {
        this.rpc_max_ms = ms;
        this.rpc_max_phase = phase;
      }
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
      if (this.rpc_max_phase === "" || ms > this.rpc_max_ms) {
        this.rpc_max_ms = ms;
        this.rpc_max_phase = phase;
      }
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
  /** NC8a: bounded phase name paired with rpc_max_ms. */
  rpc_max_phase: string;
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
  return derivedIdHex(claim.id, purpose);
}

/** Deterministic 16-byte hex derived from an opaque seed and a purpose label.
 * Object ids that must be REPRODUCIBLE from a caller's token — an elastic guest
 * claim, an operator anchor — derive here rather than allocating from a
 * counter: a never-before-seen cluster has no counter, and reproducibility is
 * what makes a lost reply replayable as the same submit. */
async function derivedIdHex(seed: string, purpose: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${purpose}\0${seed}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a gateway WebSocket carries across hibernation (Phase 4 item 3):
 * the validated session id (also the socket's tag) and the apikey-
 * authenticated actor the session is bound to. */
type GatewaySocketAttachment = { session: string; actor: string; opened_at: number };

/** Echo-dedupe LRU bound (see recentClientTurns). */
const RECENT_CLIENT_TURN_CAP = 512;

/**
 * H2c: selection-pin retention — the gateway half of a SHARED retention
 * boundary with the authority's recorded replies (scope.ts
 * IDEMPOTENCY_LEASE_MS).
 *
 * The property that has to hold is an ORDERING between two independent stores:
 * a recorded outcome must never outlive the pin that routes its retry back to
 * it. Otherwise the retry re-plans, may select a second scope, and commits
 * there — the cross-scope double execution, reached through the routing door
 * instead of the commit door.
 *
 * Counting rows cannot establish that ordering, and two successive attempts to
 * size it were both disproved by direct probes: a shard-wide row ceiling
 * deletes by global rowid and ignores scope, so many scopes each individually
 * under a per-scope cap still evict live-receipt pins; and a per-scope cap
 * counts PINS rather than pins with a live outcome, so keys that were pinned
 * and abandoned before any reply push out an older live one. No choice of
 * limits fixes either: the two stores prune on different, unrelated triggers.
 *
 * So retention is by CLOCK, shared with the authority, and eviction of an
 * unexpired guarantee is not permitted at all:
 *
 * - a pin for a client-supplied operation id is GUARANTEED. It is removed only
 *   when its lease expires. At capacity the gateway REFUSES a new guaranteed
 *   admission (`E_RETRY_CAPACITY`) rather than evict one that is still live —
 *   a visible refusal is strictly better than a silent double execution;
 * - a pin for a gateway-MINTED key is TRANSIENT. No client can reuse such a
 *   key, so it only has to survive the current request's repair loop, and it
 *   is evicted by count so it can never crowd out a guarantee.
 *
 * The gateway lease is deliberately LONGER than the authority's, so clock skew
 * between two Durable Objects cannot invert the ordering the invariant rests
 * on. Slack is the whole difference: 20 minutes here against 10 there.
 */
const GATEWAY_PIN_LEASE_MS = 20 * 60_000;
/**
 * Guaranteed pins held per shard. At ~200 bytes a row this is a few MiB of DO
 * SQL. Combined with the lease it is also a rate: sustaining more than
 * `GATEWAY_GUARANTEED_PIN_CAPACITY / GATEWAY_PIN_LEASE_MS` ≈ 55 client-keyed
 * operations per second on ONE shard for a full lease is what it takes to
 * reach the refusal, and the refusal names itself when it happens.
 */
const GATEWAY_GUARANTEED_PIN_CAPACITY = 65536;
/** Minted-key pins kept before the oldest are dropped. They only need to
 * outlive one request's repair loop, so this is generous already. */
const GATEWAY_TRANSIENT_PIN_CAPACITY = 4096;
/** Drain-watermark writes between retention sweeps. A sweep costs one COUNT
 * over a bounded table; the interval keeps that off
 * the per-poll path while still bounding growth (one row per new session). */
const MCP_WATERMARK_SWEEP_INTERVAL = 256;
/** Drain watermarks retained per shard. One row per live session, so this is a
 * session-count bound; it previously borrowed the selection-pin constant,
 * which coupled two unrelated tables through one number. */
const GATEWAY_WATERMARK_LIMIT = 2048;
/** A session bearer destroys its own credential when close commits. Keep a
 * bounded gateway-local receipt so a lost close reply can still replay as
 * success after the session cell is expired/reaped. Same bounded-idempotency
 * posture as turn pins/replies; this is derived retry state, not authority. */
const GATEWAY_SESSION_CLOSE_RECEIPT_LIMIT = 4096;
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
/** Planning-head hints are an optimistic latency cache, not authority.
 * Bound them independently of world size; hibernation or eviction merely
 * restores the ordinary /head path. */
const PLANNING_HEAD_CACHE_CAP = 256;

type PlanningHead = { head: ScopeHead; catalog_epoch?: string; object_counter?: number };

export class NetGatewayDO {
  private readonly host: WorkerdHost;
  private view: CellStore | null = null;
  private readonly seen = new Map<string, number>();
  /** Whole-scope derived copies, exact at one authority head. Ephemeral on
   * purpose: hibernation merely makes the next large direct read re-pull a
   * full closure; correctness never depends on retaining this optimization. */
  private readonly completeHeads = new Map<string, ScopeHead>();
  /** Exact `/head` replies retained only to avoid a serial warm-path hop.
   * `/submit` still proves the retained base and validates current reads and
   * post-state at authority, so a stale entry can cost repair but cannot
   * authorize stale state. */
  private readonly planningHeads = new Map<string, PlanningHead>();
  /** Per-subscriber outbox continuity, distinct from authority `seen`.
   * A scope head may advance without emitting a row for this gateway. */
  private readonly deliverySeen = new Map<string, number>();
  /** M5.1: per-scope count of LIVE (direct-route) fanout bodies applied here.
   * Live observations carry no authority sequence, so `deliverySeen` cannot
   * see them; this counter is the continuity evidence for that half. Durable
   * (net_gateway_scope.live_seq) because its whole job is to survive the
   * eviction whose loss it reports. */
  private readonly liveSeen = new Map<string, number>();
  /** Scopes with at least one durable MCP drain watermark. Only these can be
   * the subject of a continuity claim, so only these pay for a live-counter
   * write — a WS-only or never-polled shard stays free on the live path. */
  private readonly mcpWatermarkScopes = new Set<string>();
  /** True once the watermark scope set has been loaded from storage. */
  private mcpWatermarkScopesLoaded = false;
  /** Drain-watermark writes since this isolate started; drives the amortized
   * retention sweep (see recordMcpDrainWatermark). */
  private mcpWatermarkWrites = 0;
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
  /**
   * A scope may drain a pending fanout while this gateway is awaiting the
   * idempotent `/subscribe` RPC. Until the response supplies the acknowledged
   * lane prefix, a jump from the gateway's old local watermark is ambiguous:
   * it can be aged acknowledged history rather than loss. Retain only the
   * first delivery position during that one-RPC window, then judge it against
   * the returned prefix before beginning the state backfill.
   */
  private readonly deliveryResumes = new Map<string, {
    baseline: number;
    firstDeliverySeq?: number;
    firstAuthoritySeq?: number;
  }>();
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
    const gatewayVersionRow = sqlRows<{ body: string }>(
      state.storage.sql.exec("SELECT body FROM net_gateway_meta WHERE id = 'schema_version'")
    )[0];
    const gatewayVersion = gatewayVersionRow === undefined
      ? null
      : (JSON.parse(gatewayVersionRow.body) as { v?: unknown }).v;
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL, owner_scope TEXT)"
    );
    const cellColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_gateway_cell)"));
    if (!cellColumns.some((column) => column.name === "owner_scope")) {
      state.storage.sql.exec("ALTER TABLE net_gateway_cell ADD COLUMN owner_scope TEXT");
    }
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_scope (scope TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL, delivery_seen_seq INTEGER NOT NULL DEFAULT 0, live_seq INTEGER NOT NULL DEFAULT 0)");
    const scopeColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_gateway_scope)"));
    if (!scopeColumns.some((column) => column.name === "delivery_seen_seq")) {
      state.storage.sql.exec("ALTER TABLE net_gateway_scope ADD COLUMN delivery_seen_seq INTEGER NOT NULL DEFAULT 0");
    }
    // M5.1 continuity: `live_seq` counts LIVE (direct-route) fanout bodies this
    // gateway has applied for a scope. Committed fanout already has
    // `delivery_seen_seq`; live observations carry no authority sequence, so
    // without this counter a live-only loss during an eviction would go
    // unreported. Additive and derived — legacy rows start at 0, which reads
    // as "no proof", and the first drain re-baselines.
    if (!scopeColumns.some((column) => column.name === "live_seq")) {
      state.storage.sql.exec("ALTER TABLE net_gateway_scope ADD COLUMN live_seq INTEGER NOT NULL DEFAULT 0");
    }
    // M5.1 continuity watermarks. `mcpQueues` is in-memory, so a Durable
    // Object eviction destroys a polling agent's observation queue — and on
    // Cloudflare an idle gateway shard is evicted within ~10s, which is well
    // inside a turn-based agent's think time. Reporting `gap:true` on every
    // reconstruction was therefore honest but useless: the marker fired on
    // essentially every poll and carried no information.
    //
    // This table is what lets a reconstructed gateway PROVE continuity
    // instead of assuming a break: each drain records the scope the session
    // was listening to and the two per-scope delivery counters at that
    // instant. If neither counter has moved when the session comes back,
    // nothing could have been dropped for it and the reply is gap-free.
    // Purely derived state: a missing row simply means "cannot prove", which
    // is the old conservative answer.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_mcp_watermark (session TEXT PRIMARY KEY, scope TEXT NOT NULL, delivery_seq INTEGER NOT NULL, live_seq INTEGER NOT NULL, ts INTEGER NOT NULL)"
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_mcp_watermark_ts ON net_gateway_mcp_watermark (ts)"
    );
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
    // session_presence row and classifying each in JS. The column addition is
    // idempotent; schema v2 below then discards legacy unowned rows together
    // with the high-waters that could suppress their reconstruction.
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
    // Observation delivery intersects one scope with the bounded sessions
    // that have a live carrier on this gateway. Keep member as the final key
    // so that intersection never scans every occupant of a large room.
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_relation_scope_member ON net_gateway_relation (relation, owner_scope, member)"
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
    // Gateway cache schema v2 materializes cell ownership for exact full-pull
    // replacement. v1 rows cannot be classified safely in SQL, and retaining
    // their high-water while discarding an unclassified row could suppress
    // the fanout that repairs it. This is DERIVED cache state, so the one safe
    // migration is to clear cells, relation mirrors, and both high-waters in
    // one transaction; the next pull/fanout reconstructs them from authority.
    // Fresh databases create the v2 table directly and skip the reset.
    if (gatewayVersion === 1) {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM net_gateway_cell");
        state.storage.sql.exec("DELETE FROM net_gateway_relation");
        state.storage.sql.exec("DELETE FROM net_gateway_scope");
        state.storage.sql.exec(
          "UPDATE net_gateway_meta SET body = ? WHERE id = 'schema_version'",
          JSON.stringify({ v: 2 })
        );
      });
    } else if (gatewayVersion === null) {
      state.storage.sql.exec(
        "INSERT INTO net_gateway_meta (id, body) VALUES ('schema_version', ?)",
        JSON.stringify({ v: 2 })
      );
    } else if (gatewayVersion !== 2) {
      throw new Error(`unsupported net gateway cache schema version ${JSON.stringify(gatewayVersion)}`);
    }
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_cell_scope ON net_gateway_cell (owner_scope)"
    );
    // Selection pinning (fix 5c): idempotency_key → the scope the FIRST
    // submit for that key targeted. A re-plan (same key, refreshed view)
    // must never migrate the commit to a different scope — the pinned
    // scope may already hold the recorded reply, and a second scope would
    // double-commit the turn. Retention is lease-based and shared with the
    // authority's reply cache (H2c: see pinScope).
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_pin (idempotency_key TEXT PRIMARY KEY, scope TEXT NOT NULL)"
    );
    // Lease columns, added in place so an already-deployed shard keeps its
    // pins across the upgrade — dropping the table instead would blank every
    // in-flight route at exactly the moment the invariant is being repaired.
    //
    // Each column is probed INDEPENDENTLY and the whole step is one
    // transaction. Gating both ALTERs on the presence of the FIRST one is a
    // permanent brick: an interruption between the two statements leaves
    // `expires_at` present and `guaranteed` absent, every later boot then sees
    // `expires_at`, skips the block, and the index build below fails on the
    // missing column — so the shard can never initialize again. A migration
    // that is not resumable from its own halfway state is not a migration.
    //
    // Legacy rows are backfilled with a full lease and treated as guaranteed:
    // conservative in the direction that matters, since it can only retain a
    // route that is no longer needed, never discard one that is.
    state.storage.transactionSync(() => {
      const pinColumns = new Set(
        sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_gateway_pin)")).map((row) => row.name)
      );
      if (!pinColumns.has("expires_at")) {
        state.storage.sql.exec("ALTER TABLE net_gateway_pin ADD COLUMN expires_at INTEGER");
      }
      if (!pinColumns.has("guaranteed")) {
        state.storage.sql.exec("ALTER TABLE net_gateway_pin ADD COLUMN guaranteed INTEGER");
      }
      // Repairs BOTH columns, not just the one a fresh ALTER leaves null, so a
      // shard that halted midway lands in the same state as one that never
      // did. Unconditional rather than gated on the ALTERs: any row reaching
      // this table undated must not become an ageless one.
      state.storage.sql.exec(
        "UPDATE net_gateway_pin SET expires_at = COALESCE(expires_at, ?), guaranteed = COALESCE(guaranteed, 1) " +
          "WHERE expires_at IS NULL OR guaranteed IS NULL",
        Date.now() + GATEWAY_PIN_LEASE_MS
      );
    });
    // Retention sweeps read by expiry and by class; both stay off a full-table
    // scan. Every SQLite index carries the rowid as its payload already, so
    // "oldest first within a class" is served by the class index — and naming
    // rowid in the index columns is a syntax error.
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_pin_expiry ON net_gateway_pin (expires_at)"
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS net_gateway_pin_class ON net_gateway_pin (guaranteed)"
    );
    // AU1.2 durable edge-event lane: refusal records buffered here and
    // drained to the audit shards (see recordEdgeAudit).
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_audit_outbox (id TEXT PRIMARY KEY, destination TEXT NOT NULL, body TEXT NOT NULL)"
    );
    // B3: short-lived single-use WebSocket tickets. A ticket authenticates
    // one upgrade so the permanent apikey never rides the WS URL. Durable
    // (survives hibernation between mint and connect) but self-limiting:
    // TTL-reaped on every mint, and each ticket is deleted on use.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_ws_ticket (ticket TEXT PRIMARY KEY, session TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_session_close_receipt (session TEXT PRIMARY KEY, actor TEXT NOT NULL)"
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
        // Single body or the lane batch envelope (one request per lane
        // per drain pass — the 2026-07-22 receive-side batching). Rows
        // apply serially in array order, which IS the lane's
        // delivery_seq order (CO2.7): one request is one event, so
        // cross-row ordering cannot even race. The per-scope seq gate
        // makes any redelivered row a no-op, so a crash mid-batch costs
        // one redelivery, never a double apply.
        const receiveStarted = Date.now();
        const body = (await request.json()) as FanoutBody | { kind: "woo.net.fanout_batch.v1"; rows: FanoutBody[] };
        const rows = "rows" in body && Array.isArray(body.rows) ? body.rows : [body as FanoutBody];
        const applied: boolean[] = [];
        try {
          for (const row of rows) applied.push(this.receiveFanout(row));
        } catch (err) {
          // Review P2 — one event per inbound request even on failure:
          // emitting only from the success path made slow FAILED requests
          // invisible, biasing the occupancy series toward survivors.
          // `applied` counts the rows durably advanced before the throw
          // (the sender retries the whole prefix; the seq gate no-ops
          // them). status:"error" also exempts the event from sampling.
          this.metric({
            kind: "net_gateway_fanout_applied",
            scope: rows[0]?.scope ?? "",
            rows: rows.length,
            applied: applied.filter(Boolean).length,
            status: "error",
            error: String(err),
            ms: Date.now() - receiveStarted
          });
          throw err;
        }
        // Receive-side occupancy (the uninstrumented segment the
        // 2026-07-22 bake attribution pointed at): ms spans mirror
        // writes, relation deltas, presence scans, and WS pushes for the
        // whole request.
        this.metric({
          kind: "net_gateway_fanout_applied",
          scope: rows[0]?.scope ?? "",
          rows: rows.length,
          applied: applied.filter(Boolean).length,
          status: "ok",
          ms: Date.now() - receiveStarted
        });
        return json({ applied: rows.length === 1 ? applied[0] : applied });
      }
      if (request.method === "POST" && url.pathname === "/net/live") {
        const body = (await request.json()) as LiveFanoutBody | LiveFanoutBatchBody;
        const deliveries = "deliveries" in body ? body.deliveries : [body];
        if (
          !Array.isArray(deliveries)
          || deliveries.length > LIVE_FANOUT_BATCH_CAP
          || deliveries.some((delivery) =>
            delivery === null
            || typeof delivery !== "object"
            || typeof delivery.scope !== "string"
            || !Array.isArray(delivery.observations)
          )
        ) {
          return json({ error: { code: "E_INVARG", message: "invalid live fanout batch" } }, 400);
        }
        for (const delivery of deliveries) {
          // Continuity accounting BEFORE delivery (M5.1): a live observation
          // aimed at a session whose queue this gateway no longer holds is
          // lost silently, and it carries no authority sequence for a later
          // reader to notice. Counting the body durably is the only record
          // that anything happened in this scope while the queue was gone.
          // Empty bodies are not events and never break a continuity claim.
          if (Array.isArray(delivery.observations) && delivery.observations.length > 0) {
            this.advanceLiveSeen(delivery.scope);
          }
          this.pushLiveObservations(delivery);
        }
        return json({ delivered: deliveries.length });
      }
      if (request.method === "POST" && url.pathname === "/net/pull") {
        const body = (await request.json()) as { scope: string; destination: string; known?: string[] };
        return json(await this.pull(body));
      }
      if (request.method === "POST" && url.pathname === "/net/turn") {
        return json(await this.turn((await request.json()) as TurnRequest));
      }
      if (request.method === "POST" && url.pathname === "/net/provision-anchor") {
        return await this.operatorProvisionAnchor((await request.json()) as OperatorProvisionAnchorRequest);
      }
      if (request.method === "POST" && url.pathname === "/net/provision-wizard") {
        return await this.operatorProvisionWizard((await request.json()) as OperatorProvisionWizardRequest);
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
        // A current-format full seed includes the COMPLETE relation family.
        // An aged seed without that field cannot safely advance the shared
        // cell/relation high-water: fall through to the live full closure.
        if (live.head.seq === seed.head.seq && live.head.hash === seed.head.hash && seed.relations !== undefined) {
          this.discardViewOnThrow(() =>
            this.state.storage.transactionSync(() => {
              // Copy #3 provenance: these cells came through KV, not the
              // authority — mark them honestly (planning treats derived
              // and seed copies identically; the stamp is provenance).
              this.replaceScopeCells(view, body.scope, seed.cells, "seed");
              this.replaceScopeRelations(body.scope, seed.relations ?? []);
              // The exact replacement and its certificate advance are one
              // durable action. A crash cannot preserve stale members under
              // the new high-water.
              this.advanceSeen(body.scope, seed.head.seq);
            })
          );
          this.completeHeads.set(body.scope, seed.head);
          return { ok: true, installed: seed.cells.length, head: seed.head, source: "kv" };
        }
        // Seed lags the live head: named, informational (CO6 E_SEED_LAG),
        // and self-healing — the live path below rewrites the seed.
        if (live.head.seq !== seed.head.seq || live.head.hash !== seed.head.hash) {
          this.metric({
            kind: "net_seed_lag",
            code: "E_SEED_LAG",
            scope: body.scope,
            seed_head: seed.head,
            live_head: live.head
          });
        }
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
   *   when the base was the whole story, all cell proofs were retained,
   *   and the scope reported no read mismatches. A complete-head-compacted
   *   plan pulls the new complete generation and re-plans;
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
        attempt: Math.max(1, structure.current_attempt),
        envelope_bytes: 0,
        sync_rpc: structure.sync_rpc,
        scope_row_writes: 0,
        reconstructions: structure.reconstructions,
        plan_cells: structure.plan_cells,
        snapshot_cells: structure.snapshot_cells,
        rpc_ms: structure.rpc_ms,
        rpc_max_ms: structure.rpc_max_ms,
        rpc_max_phase: structure.rpc_max_phase,
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
      rpc_max_phase: structure.rpc_max_phase,
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
      ...report,
      // Reuse the stable AE phase axis instead of spending a new blob. For a
      // turn-level event it denotes the phase paired with rpc_max_ms.
      phase: report.rpc_max_phase
    });
    // AU8 span tree: root `net.turn` + phase children from the measured
    // report buckets. Adopted contexts follow the caller's sampled flag;
    // minted contexts are gated by NET_SPAN_SAMPLE. Export is
    // best-effort (woo.span log + optional OTLP push off the reply
    // path) and never the audit trail.
    if (request.trace && spanSampled(request.trace)) {
      exportSpans(
        this.env,
        this.host,
        turnSpans({
          trace: request.trace,
          now_ms: this.host.now(),
          wall_ms: report.wall_ms,
          queue_ms: report.queue_ms,
          rpc_ms: report.rpc_ms,
          status: status === "accepted" ? "ok" : "error",
          attributes: {
            "woo.scope": report.scope,
            "woo.verb": request.call.verb,
            ...(request.principal?.customer ? { "woo.customer": request.principal.customer } : {}),
            ...(request.principal?.actor ? { "woo.actor": request.principal.actor } : {}),
            ...(error ? { "woo.error": error } : {})
          }
        }),
        { service: "woo-net-gateway", instance: `net-gateway:${this.shardName() ?? "unnamed"}` }
      );
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
    // RECEIPT we last refreshed each mismatched key to. Eligible receipts
    // include the owner scope and sequenced head as well as content: using
    // content alone misclassifies A -> B -> A contention. The mutation-complete
    // authority generation makes seed and activation receipts eligible too;
    // owner-unknown probes still produce no receipt.
    const refreshedTo = new Map<string, string>();
    // Same detector for compact ordering reads. The key is
    // (authority scope, container, parent), because two container roots in one
    // cross-scope turn both use null.
    const refreshedOrderingTo = new Map<string, string>();
    // Same detector for replay-page reads, keyed by
    // (authority scope, space, from, limit) — the exact attested query.
    const refreshedReplayTo = new Map<string, string>();
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
    // Owner-served committed replay pages fetched this turn (SL4), keyed
    // by the exact (space, from, limit) query. Same lifecycle again: grown
    // by the replay-page repair path, sticky across re-plans, and purged
    // per-query on a replay conflict so the next attempt re-fetches the
    // CURRENT page (a committed append moved the window's content).
    const replayPagesByQuery = new Map<string, ReplayPageProjection>();
    // A cold contents relation can name offline actors whose owner cells are
    // intentionally absent from this gateway. The first presentation probe
    // classifies those cluster roots from the generic host-placement marker;
    // retain that bounded answer across repair rounds so one look never
    // re-probes the same offline seats.
    const roomPresentationActors = new Set(this.roomPresentationActors.keys());
    // `room_roster` is an owner-produced snapshot for this one logical turn.
    // A repair round must re-execute semantic bytecode against refreshed cells,
    // but re-fetching the same presentation snapshot only widens the turn and
    // can consume the hard RPC budget without strengthening commit validation.
    // Keep the first authoritative roster value sticky across this turn's
    // bounded attempts, just like ordered/replay projections above.
    let planningRoomRoster: { room: string; rows: readonly RoomRosterRow[] } | undefined;
    // `undefined` means not resolved yet; `null` means this call has no roster
    // dependency. A concurrent actor/session move can change the resolved room
    // after repair, in which case the next attempt must fetch the new room.
    let planningRoomRosterRoom: string | null | undefined;
    // Only a gateway-local preflight mismatch (no submit issued) may carry the
    // owner attestations it just fetched into the immediate re-plan. The
    // attestation builder reuses an owner only when every new transcript
    // version it must prove is exactly covered; any changed/new read goes live.
    // Scope-returned conflicts never populate this cache and therefore retain
    // the ordinary fresh-attestation retry.
    let preflightRetryAttestations: CommitSubmit["attestations"];

    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt += 1) {
      // The budget bounds rounds two onward; the first attempt always
      // runs (a zero-attempt turn could never converge or explain itself).
      if (attempt > 1 && this.host.now() >= deadline) break;
      structure.current_attempt = attempt;
      const elapsed = () => this.host.now() - startedAt;
      // Re-acquire the view per attempt (fix 3): a failed durable write in
      // a prior round discarded this.view; the loop must plan against the
      // rehydrated store, never a detached one. The classifier rebuilds
      // with it (CO15: it is a function of the view's lineage cells, and
      // a recovery may have refreshed them).
      const view = this.ensureView();
      const classifier = this.classifierFor(request, view);
      const resolvedRosterRoom = this.roomRosterRoom(request, view, classifier);
      if (planningRoomRosterRoom === undefined || planningRoomRosterRoom !== resolvedRosterRoom) {
        planningRoomRoster = await this.roomRosterProjection(request, view, classifier, structure, roomPresentationActors);
        planningRoomRosterRoom = resolvedRosterRoom;
      }
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
      const planningReplayPages = replayPagesByQuery.size > 0
        ? [...replayPagesByQuery.values()].map((page) => ({ space: page.space, from: page.from, limit: page.limit, scope: page.scope, entries: page.entries, version: page.version }))
        : undefined;

      // ---- Plan (or adopt the stale_head resubmit).
      let planned: PlanTurnResult;
      let base: ScopeHead | null = null;
      // Planning-scope head (client-shell phase i): learned from /head or an
      // exact prior reply and supplied BEFORE planning so the authority's
      // allocation counter reaches the planner — a create must mint an id
      // fresh at the retained base and validates that read at submit.
      // Reused as the submit base when the commit scope IS the planning
      // scope (the warm common case), keeping the warm turn at the same
      // sync-RPC count as before; a cross-scope selection re-fetches
      // from its own destination below.
      let planningHead: PlanningHead | null = null;
      if (resubmit) {
        planned = resubmit.planned;
        base = resubmit.base;
        resubmit = null;
      } else {
        try {
          planningHead = this.cachedPlanningHead(request.planningScope, request.catalog_epoch);
          if (planningHead === null) {
            planningHead = await structure.rpc(() => this.scopeHead(this.destinationFor(request, request.planningScope)), { phase: "planning_head" });
            this.rememberPlanningHead(request.planningScope, request.catalog_epoch, planningHead);
          }
          this.assertTurnEpoch(planningHead, request.catalog_epoch, request.planningScope, trace);
          const complete = this.completeHeads.get(request.planningScope);
          const compactOwnedReads = complete?.seq === planningHead.head.seq &&
            complete.hash === planningHead.head.hash &&
            complete.generation !== undefined &&
            complete.generation === planningHead.head.generation;
          planned = await this.planOnce(request, view, classifier, planningHead.object_counter, planningRoomRoster, repairedObjects, planningOrderedChildren, planningOrderedNeighbors, planningReplayPages, compactOwnedReads);
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
            // Replay-page miss (SL4): fetch the named committed-log window
            // from its owning authority and re-plan. Handled before the
            // cell path for the same reason as the ordering branches — its
            // detail carries `missing_replay_pages`, not `missing`, and
            // there is no cell to grow from the view. Anti-loop mirrors
            // the ordering branches: an already-resident re-miss is the
            // terminal planner-bug shape; a failed fetch is transient and
            // stays on the bounded attempt loop.
            const missingReplayPages = Array.isArray(err.detail.missing_replay_pages)
              ? (err.detail.missing_replay_pages as ReplayPageQuery[]).filter(validReplayPageQuery)
              : [];
            if (missingReplayPages.length > 0) {
              trace.push({ attempt, code: "E_MISSING_STATE", missing: missingReplayPages.map((q) => `replay:${q.space}@${q.from}+${q.limit}`), elapsed_ms: elapsed() });
              let allAlreadyResident = true;
              for (const query of missingReplayPages) {
                const key = replayPageQueryKey(query);
                if (replayPagesByQuery.has(key)) continue;
                allAlreadyResident = false;
                const page = await this.tryRecovery(trace, () => this.fetchReplayPage(request, classifier, structure, query));
                if (page === undefined) continue; // fetch failed; recovery_error recorded
                replayPagesByQuery.set(key, page);
              }
              if (allAlreadyResident) {
                throw nonconvergentRead(
                  "replay page re-missed while resident (install cannot cure it)",
                  trace,
                  { missing_replay_pages: missingReplayPages }
                );
              }
              continue;
            }
            const missing = Array.isArray(err.detail.missing) ? (err.detail.missing as string[]) : [];
            trace.push({ attempt, code: "E_MISSING_STATE", missing, elapsed_ms: elapsed() });
            const receipts = await this.tryRecovery(trace, () => this.refreshCells(request, classifier, view, missing, structure));
            for (const key of missing) repairedObjects.add(objectOfCellKey(key));
            if (receipts) {
              const stuck = missing.flatMap((key) => {
                const receipt = receipts.get(key);
                if (!receipt) return [];
                const identity = authorityReceiptIdentity(receipt);
                if (refreshedTo.get(key) !== identity) {
                  refreshedTo.set(key, identity);
                  return [];
                }
                const object = objectOfCellKey(key);
                const verbName = key.startsWith(`verb_bytecode:${object}:`)
                  ? key.slice(`verb_bytecode:${object}:`.length)
                  : null;
                const dispatchChain: Array<{ object: string; parent: string | null; has_page: boolean }> = [];
                if (verbName !== null) {
                  let cursor: string | null = object;
                  const seen = new Set<string>();
                  while (cursor && !seen.has(cursor)) {
                    seen.add(cursor);
                    const lineage = view.get(cellKey("object_lineage", cursor))?.value as { parent?: unknown } | undefined;
                    const parent = typeof lineage?.parent === "string" ? lineage.parent : null;
                    dispatchChain.push({
                      object: cursor,
                      parent,
                      has_page: view.has(cellKey("verb_bytecode", cursor, verbName))
                    });
                    cursor = parent;
                  }
                }
                return [{
                  key,
                  authority_scope: receipt.scope,
                  authority_head: receipt.head,
                  authority_version: receipt.version,
                  dispatch_chain: dispatchChain
                }];
              });
              if (stuck.length > 0) {
                throw nonconvergentRead(
                  "a sparse planning miss cannot converge: authority returned the same cell state twice but the planner still requested it",
                  trace,
                  { stuck, scope: request.planningScope }
                );
              }
            }
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
        // `retry_receipt` is precisely "the client chose this key and will
        // reuse it" (an MCP operation_id, or retry_safe on /net-api/turn), so
        // it is also precisely the set of keys a retry can ever look up. Those
        // pins carry the retention guarantee; a gateway-minted key only has to
        // survive this request's own repair loop.
        const guaranteed = request.retry_receipt === true;
        if (this.pinScope(request.idempotency_key, planned.selection.scope, guaranteed) === "capacity") {
          // Refuse BEFORE the submit leaves. Issuing a retry guarantee this
          // shard cannot keep would mean a lost response re-executes silently;
          // a named refusal lets the client wait, or drop the operation id and
          // accept ordinary at-least-once semantics knowingly.
          throw new NetError(
            "E_RETRY_CAPACITY",
            "this gateway shard cannot currently guarantee retry safety for a new operation id",
            {
              reason: "pin_capacity",
              retry_after_ms: 60_000,
              remediation:
                "retry this call unchanged in a moment; the guarantee is refused, not the operation"
            },
            trace
          );
        }
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
      // one — from its owner before submitting. Ordinary retries fetch
      // fresh. A gateway-local preflight mismatch issued no submit, so its
      // immediate re-plan may reuse an owner proof only when it exactly
      // covers every version the new transcript records.
      const priorPreflightAttestations = preflightRetryAttestations;
      preflightRetryAttestations = undefined;
      const attestations = await this.attestForeignReads(
        request,
        classifier,
        planned,
        view,
        targetScope,
        structure,
        priorPreflightAttestations
      );
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
      const originGateway = this.selfDestination();
      const submitBody = {
        submit,
        rider_destinations: this.riderDestinationsFor(request, classifier, planned),
        relate_destinations: relateDestinations,
        ...(planned.liveAudience !== undefined ? { live_audience: planned.liveAudience } : {}),
        ...(originGateway ? { origin_gateway: originGateway } : {})
      };
      // CO7: envelope_bytes is the ACTUAL serialized submit RPC body —
      // transcript, attestations, and rider/relation routing metadata —
      // measured here, immediately before the RPC (never a modeled
      // shape; the scope validates versions/attestations and re-applies
      // recorded writes, so no read state ships). The ceiling gate lives
      // on the same measurement: a breach is a plain misplan Error.
      const envelopeBytes = submitEnvelopeBytes(submitBody);
      const warm = targetScope === request.planningScope && planned.selection.riders.length === 0;
      // A large same-owner turn is the one valid reason to materialize a
      // complete snapshot: on the next plan, the exact base-generation CAS
      // replaces its thousands of same-scope per-cell reads. This also covers
      // read verbs transported through a room's sequenced route. Never raise
      // the CO15 ceiling.
      if (
        envelopeBytes > WARM_ENVELOPE_BYTE_LIMIT &&
        warm &&
        !planned.ownedReadsCompacted
      ) {
        await this.reseedFromScope(view, destination, [], structure);
        continue;
      }
      if (envelopeBytes > WARM_ENVELOPE_BYTE_LIMIT && warm && planned.ownedReadsCompacted) {
        const attestationCells = Object.values(submit.attestations ?? {})
          .reduce((count, attestation) => count + attestation.cells.length, 0);
        // This branch is already a terminal protocol defect. Account for each
        // sibling independently so the next occurrence identifies the actual
        // amplification source instead of reporting only transcript bytes.
        // JSON field sizes are diagnostic (their braces/keys do not add up to
        // the whole body exactly); the authoritative ceiling above remains the
        // byte size of the complete serialized submit RPC body.
        const diagnosticBytes = (value: unknown): number =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        const readBuckets = new Map<string, number>();
        for (const read of submit.transcript.reads) {
          let owner = "unresolved";
          try { owner = classifier.scopeOf(read.cell.object); } catch { /* diagnostic only */ }
          const key = `${read.cell.kind}@${owner}`;
          readBuckets.set(key, (readBuckets.get(key) ?? 0) + 1);
        }
        throw new Error(
          `oversized compacted warm envelope: ${envelopeBytes} bytes; ` +
          `wire_reads=${submit.transcript.reads.length} attestation_cells=${attestationCells} ` +
          `transcript_bytes=${new TextEncoder().encode(JSON.stringify(submit.transcript)).byteLength} ` +
          `submit_bytes=${diagnosticBytes(submit)} ` +
          `attestations_bytes=${diagnosticBytes(submit.attestations ?? {})} ` +
          `rider_destinations_bytes=${diagnosticBytes(submitBody.rider_destinations)} ` +
          `relate_destinations_bytes=${diagnosticBytes(submitBody.relate_destinations)} ` +
          `live_audience_bytes=${diagnosticBytes(planned.liveAudience ?? {})} ` +
          `origin_gateway_bytes=${diagnosticBytes(originGateway ?? "")} ` +
          `read_buckets=${JSON.stringify(Object.fromEntries(readBuckets))}`
        );
      }
      assertEnvelopeCeiling(envelopeBytes, warm);
      let reply: CommitReply;
      const attestationMismatches = this.foreignAttestationMismatches(planned, submit.attestations);
      if (attestationMismatches.length > 0) {
        // The gateway has just fetched these owner versions. Sending a
        // transcript whose recorded versions already disagree can only earn
        // the scope's retryable read_version_mismatch verdict. Synthesize that
        // exact repair input locally and preserve the submit RPC for the
        // re-planned round. Acceptance still happens only at the scope; this
        // optimization can skip a provably doomed write attempt, never accept.
        preflightRetryAttestations = submit.attestations;
        reply = {
          kind: "woo.net.commit_reply.v1",
          status: "rejected",
          scope: targetScope,
          reason: "read_version_mismatch",
          retryable: true,
          head: base,
          mismatched_reads: attestationMismatches
        };
      } else {
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
      }
      if (reply.status === "accepted") {
        // Retain the optimistic allocation/head hint only for an exact
        // head-stable accept. Any authoritative mutation (including a create)
        // changes the returned head and forces the next turn through /head.
        if (reply.scope === request.planningScope) {
          this.reconcilePlanningHead(request.planningScope, request.catalog_epoch, reply.head);
        }
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
        const pureDirect =
          request.call.route === "direct" &&
          reply.head.seq === submit.base.seq &&
          reply.head.hash === submit.base.hash &&
          reply.head.generation === submit.base.generation;
        if (pureDirect && !replayed && planned.transcript.observations.length > 0) {
          // The scope excludes this origin shard to avoid a
          // gateway→scope→same-gateway RPC cycle. Deliver its local session
          // slice here, after validation returned; other shards receive the
          // scope's independent best-effort /net/live calls.
          // Same M5.1 accounting as the /net/live route: this is the ONLY
          // record that a live observation existed in this scope, so a
          // reconstructed queue can still tell it missed one.
          this.advanceLiveSeen(reply.scope);
          this.pushLiveObservations({
            scope: reply.scope,
            observations: planned.transcript.observations,
            submitter_turn_id: request.idempotency_key,
            echo_id: turnEchoId(request.idempotency_key),
            ...(planned.liveAudience ?? {})
          });
        }
        return {
          reply,
          selection: planned.selection,
          envelopeBytes,
          attempt,
          trace,
          ...(replayed
            ? // CO2.5: serve the RECORDED outcome of the execution that
              // committed. Note what this branch must never do: fall back to
              // `planned.transcript` when the authority retained nothing.
              // That transcript describes this round's re-plan, which
              // committed nothing — presenting it would hand back a
              // plausible wrong answer (acute for now()/random() turns).
              // "Committed, outcome unavailable" is the honest reply, and
              // replayOutcomeOf names which of the two it is.
              replayedTurnOutput(reply.status === "accepted" ? reply.replay_output : undefined)
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
        return { reply, selection: planned.selection, envelopeBytes, attempt, trace };
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
          this.forgetPlanningHead(targetScope);
          const live = await this.tryRecovery(trace, () => structure.rpc(() => this.scopeHead(destination), { phase: "stale_head_refresh" }));
          // Phase 5: epoch check OUTSIDE tryRecovery (the M9 pattern) —
          // a genuine epoch disagreement is terminal and must escape the
          // retry loop, while a FAILED head fetch stays on the budget
          // path (recovery_error names it; a later round may converge).
          if (live !== undefined) {
            this.assertTurnEpoch(live, request.catalog_epoch, targetScope, trace);
            this.rememberPlanningHead(targetScope, request.catalog_epoch, live);
          }
          const fresh = live?.head;
          const headMoved = fresh !== undefined && (
            fresh.seq !== submit.base.seq ||
            fresh.hash !== submit.base.hash ||
            fresh.generation !== submit.base.generation
          );
          if (fresh !== undefined && headMoved && planned.ownedReadsCompacted) {
            // The omitted owner reads were proven only by submit.base's exact
            // generation. Replacing that base while retaining the computed
            // writes would bless stale values (lost-update under contention).
            // Pull the new complete authority generation, then re-execute.
            await this.tryRecovery(trace, () => this.reseedFromScope(view, destination, [], structure));
          } else if (fresh !== undefined && headMoved && !reply.mismatched_reads) {
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
            const stuck: Array<{ scope: string; container: string; parent: string | null; authority_version: string; authority_head: ScopeHead }> = [];
            for (const ordering of orderingConflicts) {
              const orderingKey = `${ordering.scope}\0${orderedProjectionKey(ordering.container, ordering.parent)}`;
              const children = [...orderedChildrenByParent.values()].find((cached) =>
                cached.scope === ordering.scope && cached.container === ordering.container && cached.parent === ordering.parent
              );
              const neighbor = [...orderedNeighborsByKey.values()].find((cached) =>
                cached.scope === ordering.scope && cached.container === ordering.container && cached.query.parent === ordering.parent
              );
              const authorityVersion = children?.version ?? neighbor?.version;
              const authorityHead = children?.authority_head ?? neighbor?.authority_head;
              if (authorityVersion !== undefined && authorityHead !== undefined && authorityOrderingReceiptEligible(authorityHead)) {
                const receipt = authorityReceiptIdentity({ scope: ordering.scope, head: authorityHead, version: authorityVersion });
                if (refreshedOrderingTo.get(orderingKey) === receipt) {
                  stuck.push({ ...ordering, authority_version: authorityVersion, authority_head: authorityHead });
                } else {
                  refreshedOrderingTo.set(orderingKey, receipt);
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
                "an ordering read cannot converge: re-installed the same authority head and content but the plan re-recorded a mismatching version",
                trace,
                { stuck, scope: targetScope }
              );
            }
            break; // re-plan next round with the refreshed ordering
          }
          // SL4: a replay-page conflict — a committed sequenced entry
          // landed inside an attested window between plan and submit.
          // Drop the named queries' cached pages so the next attempt
          // re-fetches the CURRENT page (via the replay-page miss path)
          // and re-plans against it. Non-convergence mirrors the ordering
          // detector: the same authority head + page version rejected
          // twice is a planner bug, named — never ground to E_BUDGET.
          const replayConflicts = Array.isArray((reply.detail as { replay_conflicts?: unknown } | undefined)?.replay_conflicts)
            ? ((reply.detail as { replay_conflicts: ReplayConflict[] }).replay_conflicts).filter(validReplayConflict)
            : [];
          if (replayConflicts.length > 0) {
            const stuck: Array<ReplayConflict & { authority_version: string; authority_head: ScopeHead }> = [];
            for (const conflict of replayConflicts) {
              const conflictKey = `${conflict.scope}\0${replayPageQueryKey(conflict)}`;
              const cached = [...replayPagesByQuery.values()].find((page) =>
                page.scope === conflict.scope && page.space === conflict.space && page.from === conflict.from && page.limit === conflict.limit
              );
              if (cached !== undefined && authorityOrderingReceiptEligible(cached.authority_head)) {
                const receipt = authorityReceiptIdentity({ scope: conflict.scope, head: cached.authority_head, version: cached.version });
                if (refreshedReplayTo.get(conflictKey) === receipt) {
                  stuck.push({ ...conflict, authority_version: cached.version, authority_head: cached.authority_head });
                } else {
                  refreshedReplayTo.set(conflictKey, receipt);
                }
              }
              for (const [key, page] of replayPagesByQuery) {
                if (page.scope === conflict.scope && page.space === conflict.space && page.from === conflict.from && page.limit === conflict.limit) {
                  replayPagesByQuery.delete(key);
                }
              }
            }
            if (stuck.length > 0) {
              throw nonconvergentRead(
                "a replay-page read cannot converge: re-installed the same authority head and page content but the plan re-recorded a mismatching version",
                trace,
                { stuck, scope: targetScope }
              );
            }
            break; // re-plan next round with the refreshed page
          }
          // Refresh exactly the named cells (or, for a post_state
          // disagreement naming nothing, reseed the scope's closure)
          // and re-plan.
          const receipts = await this.tryRecovery(trace, async () => {
            if (mismatchKeys.length > 0) return await this.refreshCells(request, classifier, view, mismatchKeys, structure);
            await this.reseedFromScope(view, destination, undefined, structure);
            return new Map<string, AuthorityReadReceipt>();
          });
          for (const key of mismatchKeys) repairedObjects.add(objectOfCellKey(key));
          // Non-convergence detector (see refreshedTo above). Only when the
          // refresh produced an AUTHORITATIVE RECEIPT: a key already refreshed
          // to this exact owner head + content version that mismatched again
          // cannot converge, so fail fast and named. Failed recovery and
          // unresolved owner probes yield no receipt and stay on E_BUDGET.
          // Including the head prevents A -> B -> A contention from looking
          // stable merely because content-address A repeated.
          if (receipts) {
            const stuck = mismatchKeys
              .map((key) => {
                const receipt = receipts.get(key);
                if (!receipt) return null;
                const identity = authorityReceiptIdentity(receipt);
                if (refreshedTo.get(key) === identity) {
                  const plannedRead = submit.transcript.reads.find((read) => netCellKeyFor(read.cell) === key);
                  return {
                    key,
                    authority_scope: receipt.scope,
                    authority_head: receipt.head,
                    authority_version: receipt.version,
                    planned_version: String(plannedRead?.version ?? "absent")
                  };
                }
                // First refresh to this receipt (or authority advanced): record
                // it and keep repairing.
                refreshedTo.set(key, identity);
                return null;
              })
              .filter((entry): entry is { key: string; authority_scope: string; authority_head: ScopeHead; authority_version: string; planned_version: string } => entry !== null);
            if (stuck.length > 0) {
              throw nonconvergentRead(
                "a recorded read cannot converge: refreshed to the same authority head and content twice but the plan re-recorded a mismatching version",
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
        // CO16.4. The route stays `direct`, and that is a session posture
        // here, not a log posture: the net pipeline's `sequenced` route
        // requires a session (CO14), and a scheduled turn deliberately has
        // none — the actor may not even be connected. Dispatching it as
        // `sequenced` fails in planning with E_BUDGET, so "authorize it like
        // a sequenced call" is not expressible as a route swap.
        //
        // What DOES hold, and is the substantive point: `direct_callable` is
        // an INGRESS gate (gateway-do's client path checks it; this internal
        // path does not), so a scheduled turn may reach a verb that external
        // direct dispatch would refuse. That is bounded by the ordinary
        // permission kernel running against the recorded actor at fire time,
        // which is the same authority that actor already holds — but it is a
        // real difference from the client surface and is documented as one.
        route: "direct",
        scope: body.scope,
        actor: turn.call.actor,
        target: turn.call.target,
        verb: turn.call.verb,
        args: turn.call.args as PlanTurnInput["call"]["args"],
        // CO16.8 fire-time context, on a TOP-LEVEL field rather than in
        // `body`: body is client-supplied on /net-api/turn, and this marker
        // relaxes the ingress gate and presents `caller = $system`, so it must
        // sit somewhere no request can reach. The client route builds its call
        // field by field, so nothing a caller sends lands here.
        scheduled: {
          id: turn.id,
          at: turn.at_logical_time,
          fired_at: Date.now()
        }
      },
      ...(scheduledPrincipal ? { principal: scheduledPrincipal } : {}),
      ...(scheduledTrace ? { trace: scheduledTrace } : {}),
      planningScope: body.scope,
      catalog_epoch: body.catalog_epoch,
      idempotency_key: key
    });
  }

  /**
   * /net/provision-anchor — AP11.9 operator identity anchor.
   *
   * A fresh net install seeds no human and no account instance (verified: the
   * install plan's partitions contain zero of either), and the net stack
   * exposes no signup route, so a freshly cut-over world has nothing for AP11
   * to anchor to. This mints that anchor.
   *
   * It is a GENESIS SUBMIT, not a turn — see identity-anchor.ts for why a turn
   * cannot express "bring a new authority cluster into existence" and why the
   * minted identity is inert (no password, no OAuth, no key, no session).
   *
   * Idempotent on `anchor_id`: the object ids derive from it, so a replay is a
   * byte-identical submit that the sequencer collapses. A re-run against an
   * anchor that already exists reports it without a second commit.
   */
  private async operatorProvisionAnchor(body: OperatorProvisionAnchorRequest): Promise<Response> {
    const anchorId = typeof body.anchor_id === "string" ? body.anchor_id.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(anchorId)) {
      return json({ error: { code: "E_INVARG", message: "anchor_id must be 1..128 chars of [A-Za-z0-9._:-]" } }, 400);
    }
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 128) : `operator anchor ${anchorId}`;
    const agentQuota = Number.isSafeInteger(body.agent_quota) && Number(body.agent_quota) > 0
      ? Math.min(Number(body.agent_quota), 64)
      : 5;
    let epoch: string;
    try {
      epoch = (await this.catalogIdentity()).epoch;
    } catch (err) {
      if (err instanceof ClientAuthError) {
        return json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status);
      }
      throw err;
    }
    // Object ids are derived from the token, not allocated: a genesis cluster
    // has no counter, and derivation is what makes a lost reply replayable.
    const anchorHex = await derivedIdHex(anchorId, "operator-anchor");
    const { human, account } = identityAnchorIds(anchorHex);
    const clusterScope = `cluster:${human}`;

    // An anchor that already exists is reported, not re-committed. The submit
    // below would also collapse idempotently, but answering from the authority
    // read keeps a re-run free of a write attempt entirely.
    await this.warmScopes([{ scope: clusterScope, objects: [human] }], "net_provision_anchor_pull_miss_failed");
    const present = this.ensureView().has(cellKey("object_lineage", human));
    if (body.probe === true) {
      return json({ ok: true, probe: true, created: false, exists: present, human, account, scope: clusterScope, catalog_epoch: epoch });
    }
    if (present) {
      return json({ ok: true, created: false, human, account, scope: clusterScope, catalog_epoch: epoch });
    }

    const planned = provisionAnchorSubmit({
      human,
      account,
      label,
      now: this.host.now(),
      epoch,
      agentQuota,
      humanClass: ANCHOR_HUMAN_CLASS,
      accountClass: ANCHOR_ACCOUNT_CLASS
    });
    const reply = await this.idempotentSubmit(`scope:${planned.clusterScope}`, planned.submit);
    if (reply.status !== "accepted") {
      this.metric({ kind: "net_provision_anchor", scope: planned.clusterScope, status: "error", error: JSON.stringify(reply) });
      return json({ error: { code: "E_RETRY", message: "anchor provisioning did not commit; retry", detail: reply } }, 503);
    }
    try {
      await this.installTouched(this.ensureView(), `scope:${planned.clusterScope}`, reply.touched);
    } catch (err) {
      // Acceptance is durable; only this gateway's own view is behind, and the
      // next pull refreshes it. Named rather than silently swallowed.
      this.metric({ kind: "net_provision_anchor_install_degraded", scope: planned.clusterScope, status: "error", error: String(err) });
    }
    await this.selfSubscribe(planned.clusterScope);
    this.metric({ kind: "net_provision_anchor", scope: planned.clusterScope, status: "ok" });
    return json({ ok: true, created: true, human, account, scope: planned.clusterScope, catalog_epoch: epoch });
  }

  /**
   * /net/provision-wizard — AP11 signed-operator wizard provisioning.
   *
   * Why this is a TURN and not a cell write like the repair family: every other
   * signed operator op repairs state whose correct value is derivable outside
   * the world (a definition page, a contents row, a seeded map). Provisioning
   * an actor is not derivable — it consumes quota, advances counters, appends
   * to `account.actors`, anchors an object, and composes the programmer
   * surface. Writing those cells operator-side would fork the world's own
   * accounting into a second implementation. Running the world's primitive
   * through the ordinary planner keeps one implementation and makes the
   * accepted transcript the audit record (AU1), exactly like the human's own
   * self-service promote.
   *
   * The whole sequence is ONE turn, so it is atomic: a failure at any step
   * commits nothing. Re-running with the same `provision_id` converges.
   *
   * The actor is the catalog wizard `$wiz` — usable here precisely because this
   * is not a client turn: the client path refuses a `$`-anchored planning scope
   * (`unplannable_scope`), which is the lock this op exists to break. The turn
   * plans and commits at the HUMAN's authority cluster, where the account, the
   * new agent, and its api-key record all live.
   */
  private async operatorProvisionWizard(body: OperatorProvisionWizardRequest): Promise<Response> {
    const human = typeof body.human === "string" ? body.human.trim() : "";
    const provisionId = typeof body.provision_id === "string" ? body.provision_id.trim() : "";
    if (!human || !provisionId) {
      return json({ error: { code: "E_INVARG", message: "provision requires human and provision_id" } }, 400);
    }
    if (!isConcreteRuntimeObjectId(human) || human.startsWith("$")) {
      // A `$`-prefixed target is catalog substrate: its cells live in the
      // catalog scope, so the turn could not write an account there anyway.
      return json({ error: { code: "E_INVARG", message: "provision human must be a concrete non-catalog object id" } }, 400);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provisionId)) {
      return json({ error: { code: "E_INVARG", message: "provision_id must be 1..128 chars of [A-Za-z0-9._:-]" } }, 400);
    }
    const apiKeyId = typeof body.api_key_id === "string" ? body.api_key_id.trim() : "";
    const probe = body.probe === true;
    // Named world-state verdicts (not installed / not active) rather than the
    // generic 500 the outer handler would give a ClientAuthError: an operator
    // running this against a half-installed namespace must be able to tell
    // "the world is not ready" from "the op is broken".
    let epoch: string;
    try {
      epoch = (await this.catalogIdentity()).epoch;
    } catch (err) {
      if (err instanceof ClientAuthError) {
        return json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status);
      }
      throw err;
    }
    const planningScope = await this.clientPlanningScope(human, human);
    if (!planningScope.startsWith("cluster:")) {
      return json({
        error: {
          code: "E_INVARG",
          message: "provision human does not classify to an authority cluster",
          detail: { human, scope: planningScope }
        }
      }, 400);
    }
    await this.warmScopes([CATALOG_SCOPE, { scope: planningScope, objects: [human] }], "net_provision_wizard_pull_miss_failed");
    // Warm the account and, if this provision_id already minted an agent, that
    // agent too. A property read of an unwarmed instance silently returns the
    // CLASS default (quota 0, provision_id null) rather than an error the
    // repair loop could act on, and here that would mean either a spurious
    // refusal or a duplicate identity. The declared argSpec prefetch covers the
    // same ground for any other caller; this is the explicit belt.
    //
    // These pulls are HARD, unlike the best-effort prefetch elsewhere: a
    // degraded read here does not fail loudly, it produces a plan that reads
    // class defaults (quota 0, provision_id null) and would then either refuse
    // confusingly or grant the wrong headroom. Failing the operator's request
    // is the correct outcome.
    // The acting principal is the OWNER of the provisioning primitive, read
    // from the resolved verb page — the same data-driven derivation the guest
    // door uses for `maintenance_principal`. The gateway therefore never names
    // `$wiz`, and a world whose primitive is absent refuses here with a legible
    // message instead of an E_VERBNF deep inside planning.
    const page = this.callVerbPage(this.ensureView(), {
      kind: "woo.turn_call.shadow.v1",
      id: `provision-probe:${human}`,
      route: "direct",
      scope: human,
      actor: human,
      target: human,
      verb: "provision_wizard_agent",
      args: []
    });
    const principal = typeof page?.owner === "string" && page.owner ? page.owner : null;

    // "No such human" and "no such primitive" both make callVerbPage return
    // null — it resolves through the TARGET'S lineage chain, so an absent
    // target has no chain to walk. Reporting both as E_VERBNF sent an operator
    // hunting for a missing verb when the real answer was a missing identity,
    // and those are opposite remedies (repair the definition vs seed an
    // anchor). Separate them explicitly from the view.
    const humanPresent = this.ensureView().has(cellKey("object_lineage", human));
    if (probe) {
      // VIEW-ONLY, and deliberately placed before the authority prefetch below:
      // that prefetch is HARD (a degraded read there would silently mis-plan a
      // real run), but a diagnostic must never fail closed — a probe that
      // refuses tells the operator nothing, which is the whole failure this
      // command exists to prevent.
      const probeAccount = this.netObjectProperty(human, "account");
      const probeLedger = typeof probeAccount === "string" && probeAccount
        ? this.netObjectProperty(probeAccount, "operator_provisioned_agents")
        : undefined;
      const probeRecordedAgent = probeLedger && typeof probeLedger === "object" && !Array.isArray(probeLedger)
        && Object.hasOwn(probeLedger as Record<string, unknown>, provisionId)
        ? ((probeLedger as Record<string, unknown>)[provisionId] as string | null) ?? null
        : null;
      // The primitive's presence is read from the CLASS PAGE directly, not from
      // `principal`: verb resolution runs through the target's lineage chain,
      // so with no human it could not answer at all — and a probe that can only
      // report the first missing thing costs the operator a round trip per
      // missing thing. Both facts are independent, so report both.
      const primitiveInstalled = principal !== null
        || this.ensureView().has(cellKey("verb_bytecode", ANCHOR_HUMAN_CLASS, "provision_wizard_agent"));
      // The published authoring-surface reference. A world installed before its
      // catalog began publishing this scalar has no cell at all, and
      // provisioning REFUSES there rather than minting a wizard with authority
      // and no verbs — so the probe must predict that refusal, not let the
      // operator discover it by running the real thing. It is also the only way
      // to read this catalog-scope value from outside: /net-api/cell is
      // presence-scoped and refuses it even for a wizard.
      const authoringSurface = this.netObjectProperty("$system", "programmer_surface");
      const surfacePublished = typeof authoringSurface === "string" && authoringSurface.length > 0;
      const steps: string[] = [];
      if (!humanPresent) steps.push("seed an operator anchor (POST /net-operator/identity/anchor)");
      if (!primitiveInstalled) {
        steps.push("install the primitive (npm run repair:net-definitions -- <worker> '$human:provision_wizard_agent')");
      }
      if (!surfacePublished) {
        steps.push("deliver seeded scalars (npm run repair:net-seed-properties -- <worker>)");
      }
      return json({
        ok: true,
        probe: true,
        scope: planningScope,
        catalog_epoch: epoch,
        human,
        human_present: humanPresent,
        human_class: humanPresent ? this.netAncestry(human, 6) : [],
        account: typeof probeAccount === "string" ? probeAccount : null,
        primitive_installed: primitiveInstalled,
        authoring_surface: surfacePublished ? authoringSurface : null,
        recorded_agent: probeRecordedAgent,
        // Every remaining step, in order, so one probe is a complete plan.
        next: steps.length === 0 ? ["ready: run the provisioning op"] : steps
      });
    }
    let recordedAgent: string | null = null;
    const account = this.netObjectProperty(human, "account");
    if (typeof account === "string" && account) {
      const prefetch = async (object: string, role: string): Promise<void> => {
        try {
          await this.pullTargeted(planningScope, `scope:${planningScope}`, [object]);
        } catch (err) {
          this.metric({ kind: "net_provision_wizard_prefetch", scope: planningScope, status: "error", error: String(err) });
          throw netError("E_MISSING_STATE", `wizard provisioning could not read the ${role} authority state`, {
            scope: planningScope,
            object,
            role
          });
        }
      };
      await prefetch(account, "account");
      const ledger = this.netObjectProperty(account, "operator_provisioned_agents");
      // OWN-key read. A provision_id is operator-chosen text and the wire
      // grammar admits `constructor`, `toString`, and friends; plain indexing
      // would resolve an inherited Object.prototype member and hand a function
      // to the prefetch as if it were a recorded agent id.
      const recorded = ledger && typeof ledger === "object" && !Array.isArray(ledger)
        && Object.hasOwn(ledger as Record<string, unknown>, provisionId)
        ? (ledger as Record<string, unknown>)[provisionId]
        : undefined;
      if (typeof recorded === "string" && recorded) {
        recordedAgent = recorded;
        await prefetch(recorded, "recorded agent");
      }
    }
    // Each invocation is its OWN turn. The durable idempotency handle is the
    // operator's `provision_id`, enforced inside the primitive: a re-run
    // converges (creates nothing, grants nothing, returns the same agent). A
    // stable turn key would instead replay the first commit's cached reply,
    // which carries no result value — so a retry after a lost reply could not
    // learn the agent id it needs for the credential step. Two concurrent runs
    // are safe: the second loses the read-version check, repairs, replans
    // against the committed state, and reports `created: false`.
    const key = `operator-provision-wizard:${human}:${provisionId}:${crypto.randomUUID()}`;
    if (!humanPresent) {
      return json({
        error: {
          code: "E_OBJNF",
          message: "provision human does not exist at its authority scope; seed an operator anchor first",
          detail: { human, scope: planningScope, remedy: "POST /net-operator/identity/anchor" }
        }
      }, 409);
    }
    if (!principal) {
      return json({
        error: {
          code: "E_VERBNF",
          message: "this world does not install the provision_wizard_agent primitive",
          detail: {
            human,
            verb: "provision_wizard_agent",
            remedy: "npm run repair:net-definitions -- <worker> '$human:provision_wizard_agent'"
          }
        }
      }, 409);
    }
    const result = await this.turn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: key,
        route: "direct",
        scope: human,
        actor: principal,
        target: human,
        verb: "provision_wizard_agent",
        args: [
          provisionId,
          {
            ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
            ...(typeof body.purpose === "string" ? { purpose: body.purpose } : {}),
            ...(apiKeyId ? { api_key_id: apiKeyId } : {})
          }
        ] as PlanTurnInput["call"]["args"]
      },
      planningScope,
      catalog_epoch: epoch,
      idempotency_key: key
    });
    if (result.reply.status !== "accepted" || result.error !== undefined) {
      this.metric({ kind: "net_provision_wizard", scope: planningScope, status: "error", error: JSON.stringify(result.error ?? result.reply) });
      return json({
        ok: false,
        scope: planningScope,
        reply: result.reply,
        ...(result.error !== undefined ? { error: result.error } : {})
      }, 409);
    }
    this.metric({ kind: "net_provision_wizard", scope: planningScope, status: "ok" });
    return json({ ok: true, scope: planningScope, catalog_epoch: epoch, result: result.result ?? null, reply: result.reply });
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
    // Phase 5: the session mint stamps request.catalog_epoch. Reuse this
    // gateway's exact accepted cluster-head hint when present; it is only an
    // optimistic base, and /submit still rejects a stale generation/head.
    // A miss pays /head and preserves the ordinary fail-fast epoch check.
    let planningHead = this.cachedPlanningHead(clusterScope, request.catalog_epoch);
    if (planningHead === null) {
      planningHead = await this.scopeHead(destination);
      this.rememberPlanningHead(clusterScope, request.catalog_epoch, planningHead);
    }
    this.assertTurnEpoch(planningHead, request.catalog_epoch, clusterScope, []);
    let base = planningHead.head;
    const actorLineage = view.get(cellKey("object_lineage", request.actor))?.value as { name?: unknown } | undefined;
    // AU3.1 rule-4 backfill: an EXCLUSIVE mint is definitionally an
    // identity-door pool claim, and a pool actor with no valid
    // customer_of predates the audit lane (the live cutover world's
    // seats; fresh installs stamp the pool at install time). The claim's
    // caller warmed the cluster with objects:[actor], so an absent cell
    // here is durably absent — stamp the guest attribution in the mint
    // commit rather than serving unattributed turns (the
    // net_turn_unattributed 29% finding, 2026-07-21). Non-exclusive
    // mints never backfill: a $human/agent missing customer_of is a
    // pipeline gap that must stay visible.
    const stampGuestCustomerOf =
      request.exclusive === true &&
      !request.closing &&
      normalizeCustomerAttribution(view.get(customerOfCellKey(request.actor))?.value) === null;
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
      ...(request.apikey_id ? { apikeyId: request.apikey_id } : {}),
      ...(request.roster_visible === false ? { rosterVisible: false } : {}),
      ...(request.exclusive ? { exclusive: true } : {}),
      ...(stampGuestCustomerOf ? { stampGuestCustomerOf: true } : {}),
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
      planningHead = await this.scopeHead(destination);
      this.assertTurnEpoch(planningHead, request.catalog_epoch, clusterScope, []);
      this.rememberPlanningHead(clusterScope, request.catalog_epoch, planningHead);
      base = planningHead.head;
    }
    if (reply.status !== "accepted") return { reply, scope: clusterScope, value };
    // Session commits never allocate objects, so the accepted authority head
    // can advance the cached base while retaining the allocation counter from
    // the exact prior /head. A concurrent later write merely causes the normal
    // stale_head repair; the cache is not an authority certificate.
    this.rememberPlanningHead(clusterScope, request.catalog_epoch, {
      ...planningHead,
      head: reply.head
    });
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
      this.installAcceptedSessionEcho(request.session, value, reply, request.catalog_epoch, clusterScope);
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
  //   POST /net-api/turn {target, verb, args?, route?, session, idempotency_key?}
  //     → REQUIRES a valid session (the CO14 Phase-4 rule: client-
  //       originated turns need sessions), validated from the session
  //       cell in the gateway view; defaults to sequenced, while an explicit
  //       direct route requires direct_callable metadata. The committing
  //       scope revalidates the session on either route (the gateway
  //       authenticates, scopes authorize), then runs
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

  /**
   * AU1.2/AU6.1: durable gateway edge-event lane. Rows persist in the
   * same isolate write as the refusal and drain to the audit shards from
   * the DO ALARM event — never a request-deferred task, whose inherited
   * lineage compounded into the platform's subrequest-depth limit under
   * burst load (CO2.7's event-break rule, learned live 2026-07-21). The
   * alarm also closes the old liveness caveat: a quiet gateway's tail
   * rows deliver on the armed wake, not the next request.
   */
  private recordEdgeAudit(
    kind: "auth" | "session" | "refusal",
    outcome: string,
    path: string,
    credential: string | null,
    actor: string | null
  ): void {
    try {
      const shardCount = Number(this.env.NET_AUDIT_SHARDS ?? 0);
      if (!Number.isFinite(shardCount) || shardCount <= 0) return;
      const attribution = actor
        ? normalizeCustomerAttribution(this.ensureView().get(customerOfCellKey(actor))?.value)
        : null;
      const principal: Principal =
        actor !== null
          ? attribution
            ? {
                attribution: "authenticated",
                customer: attribution.customer,
                actor,
                ...(credential ? { credential } : {})
              }
            : credential
              ? { attribution: "credentialed", credential, actor }
              : { attribution: "anonymous" }
          : credential
            ? { attribution: "credentialed", credential }
            : { attribution: "anonymous" };
      const routed = mintGatewayAuditRecord({
        gateway: `net-gateway:${this.shardName() ?? "unnamed"}`,
        eventId: `edge:${crypto.randomUUID()}`,
        kind,
        principal,
        outcome,
        target: path,
        now: this.host.now()
      });
      for (const entry of routed) {
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO net_gateway_audit_outbox (id, destination, body) VALUES (?, ?, ?)",
          `${entry.partition}/${entry.record.idempotency}`,
          `audit:${auditShardFor(entry.partition, shardCount)}`,
          JSON.stringify(entry)
        );
      }
      // CO2.7 event break: the append RPC must NOT run in this request's
      // lineage. A deferred (waitUntil) task inherits it, and under burst
      // load the inherited chains compound into the platform's
      // "Subrequest depth limit exceeded" — observed on turn responses the
      // first time this path deployed. An immediate storage alarm is a
      // FRESH event with fresh lineage; rows are durable, so the alarm is
      // the crash-safe continuation (the same rule the scope applies to
      // its post-submit outbox drain).
      this.host.setAlarm(GATEWAY_AUDIT_ALARM_KEY, this.host.now(), async () => {});
    } catch (err) {
      // Edge auditing must never turn a refusal into a 500.
      this.metric({ kind: "net_gateway_audit_error", status: "error", error: String(err) });
    }
  }

  /**
   * DO alarm wake — the gateway's only alarm consumer today is the edge
   * audit outbox (the CO2.7 fresh-lineage continuation for
   * drainEdgeAudit). Like the scope's alarm(), it re-derives due work
   * from durable state: rows either drain or re-arm below, so an alarm
   * armed by an evicted lifetime still lands somewhere useful.
   */
  async alarm(): Promise<void> {
    this.host.setAlarm(GATEWAY_AUDIT_ALARM_KEY, null, async () => {});
    await this.drainEdgeAudit();
  }

  /** At-least-once push of edge rows to their shards; delivered rows
   * delete, failures re-arm the alarm with a short backoff (a quiet
   * shard must not strand rows until its next request). */
  private async drainEdgeAudit(): Promise<void> {
    const rows = sqlRows<{ id: string; destination: string; body: string }>(
      this.state.storage.sql.exec("SELECT id, destination, body FROM net_gateway_audit_outbox LIMIT 64")
    );
    const byDestination = new Map<string, Array<{ id: string; body: string }>>();
    for (const row of rows) {
      const bucket = byDestination.get(row.destination) ?? [];
      bucket.push({ id: row.id, body: row.body });
      byDestination.set(row.destination, bucket);
    }
    for (const [destination, bucket] of byDestination) {
      try {
        await this.host.rpc(destination, "/audit-append", {
          from_scope: `net-gateway:${this.shardName() ?? "unnamed"}`,
          seq: 0,
          records: bucket.map((row) => JSON.parse(row.body) as unknown)
        });
        for (const row of bucket) {
          this.state.storage.sql.exec("DELETE FROM net_gateway_audit_outbox WHERE id = ?", row.id);
        }
      } catch (err) {
        this.metric({ kind: "net_gateway_audit_error", status: "error", error: String(err), destination });
      }
    }
    // Residue (a failed shard, or rows enqueued since the SELECT): re-arm
    // rather than strand until the next audited request on this shard.
    const remaining = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT EXISTS(SELECT 1 FROM net_gateway_audit_outbox) AS n")
    )[0];
    if (remaining && Number(remaining.n) > 0) {
      this.host.setAlarm(GATEWAY_AUDIT_ALARM_KEY, this.host.now() + GATEWAY_AUDIT_RETRY_MS, async () => {});
    }
  }

  /** AU7: partition-scoped query. The caller's customer_of names the
   * partition; the operator partition may name any. */
  private async clientAuditQuery(actor: string, body: Record<string, unknown>): Promise<Response> {
    const shardCount = Number(this.env.NET_AUDIT_SHARDS ?? 0);
    if (!Number.isFinite(shardCount) || shardCount <= 0) {
      return json({ error: { code: "E_OBJNF", message: "audit trail is not enabled on this deployment" } }, 404);
    }
    await this.warmScopes([CATALOG_SCOPE, { scope: `cluster:${actor}`, objects: [actor] }], "net_client_pull_miss_failed");
    const attribution = normalizeCustomerAttribution(this.ensureView().get(customerOfCellKey(actor))?.value);
    if (attribution === null) {
      return json(
        { error: { code: "E_PERM", message: "actor has no customer attribution (audit.md AU3.1); audit access requires one" } },
        403
      );
    }
    const requested = typeof body.partition === "string" && body.partition.length > 0 ? body.partition : null;
    const partition =
      requested !== null && attribution.customer === OPERATOR_CUSTOMER_ID ? requested : attribution.customer;
    if (requested !== null && partition !== requested) {
      // AU10.5: identity-level isolation — a non-operator naming any
      // partition (even their own) is answered from their OWN identity,
      // and naming someone else's is a named refusal, not a filter.
      return json({ error: { code: "E_PERM", message: "partition is operator-only; your own partition is implicit" } }, 403);
    }
    const filters: Record<string, unknown> = {};
    for (const field of ["actor", "verb", "target", "outcome", "trace_id"] as const) {
      if (typeof body[field] === "string" && (body[field] as string).length > 0) filters[field] = body[field];
    }
    for (const field of ["from_ts", "to_ts", "limit"] as const) {
      if (typeof body[field] === "number" && Number.isFinite(body[field])) filters[field] = body[field];
    }
    const reply = (await this.host.rpc(`audit:${auditShardFor(partition, shardCount)}`, "/audit-query", {
      partition,
      ...filters
    })) as { records?: unknown[] };
    return json({ partition, records: reply.records ?? [] });
  }

  private async clientApi(request: Request, url: URL): Promise<Response> {
    // AU1.2 edge-record capture: what the auth boundary learned before a
    // refusal, so the catch below can attribute the attempt. Assigned as
    // the try progresses; never trusted from client input.
    let auditCredential: string | null = null;
    let auditActor: string | null = null;
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
        const rejectedOrigin = rejectForeignMcpOrigin(request, this.env);
        if (rejectedOrigin) return rejectedOrigin;
      }
      if (request.method === "POST" && url.pathname === "/net-api/mcp") {
        return await this.clientMcp(request);
      }
      if (request.method === "GET" && url.pathname === "/net-api/mcp") {
        return await this.clientMcpEvents(request);
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
      auditCredential = credential.kind === "apikey" ? credential.id : `session:${credential.session}`;
      // Close is the one route whose successful effect invalidates its own
      // authentication credential. A response-lost retry therefore cannot
      // pass ordinary bearer validation. The gateway that minted/routed the
      // session retains a bounded durable receipt; consume it before the live
      // bearer gate and return the original semantic success.
      //
      // There is one wider dropped-reply window: both bounded internal submit
      // replies can be lost after authority accepted, so this gateway never
      // gets to write its receipt. Its derived session cell still binds the
      // opaque bearer to an actor even though the value is now expired. Let
      // that exact bearer reach the idempotent close path, which proves the
      // already-released postcondition and writes the missing receipt. This
      // grants no use of an expired session beyond destroying itself. Unknown
      // random session ids still take the normal fail-closed auth path below.
      if (request.method === "DELETE" && url.pathname === "/net-api/session" && credential.kind === "session") {
        const closedActor = this.closedSessionActor(credential.session);
        if (closedActor) {
          auditActor = closedActor;
          this.enforceClientRate(closedActor, url.pathname);
          return json({ closed: true, already: "closed" });
        }
        const value = this.ensureView().get(sessionCellKey(credential.session))?.value as {
          id?: unknown;
          actor?: unknown;
        } | undefined;
        if (value?.id === credential.session && typeof value.actor === "string") {
          auditActor = value.actor;
          this.enforceClientRate(value.actor, url.pathname);
          const identity = await this.catalogIdentity();
          return await this.clientSessionClose(value.actor, credential.session, identity.epoch);
        }
      }
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
        actor = await this.authorizedActorForSessionBearer(credential.session, identity.map);
        bearerSession = credential.session;
      } else {
        actor = (await this.verifyClientApiKey(identity.map, credential)).actor;
        // The apikey class needs the SAME retirement gate as the bearer class
        // above. Eligibility is otherwise only checked when a session is
        // MINTED, so a retired actor presenting a long-lived key plus an
        // already-minted session id kept transacting — verified: a revoked
        // wizard committed a wizard-only set_quota turn this way. `revoke_agent`
        // revokes only the key `agent.api_key_id` names, so any second
        // credential on that actor survives retirement and reaches here.
        this.assertActorNotRetired(actor);
      }

      // H4: rate limiting runs AFTER authentication resolves the actor
      // (so buckets key on identity, never on spoofable request bytes)
      // and BEFORE any dispatch — a throttled client costs one map lookup.
      auditActor = actor;
      this.enforceClientRate(actor, url.pathname);

      // AU7: the customer audit-query surface. The PARTITION comes from
      // the caller's own attribution (customer_of) — a customer cannot
      // name someone else's partition (AU10.5 isolation is identity-
      // level, not filter-level). The operator partition may name any
      // partition explicitly (the operator sees everything by design).
      if (request.method === "POST" && url.pathname === "/net-api/audit") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return await this.clientAuditQuery(actor, body);
      }

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
        return await this.clientSession(actor, body, identity.epoch, {
          ...(credential.kind === "apikey" ? { apiKeyId: credential.id } : {})
        });
      }
      if (request.method === "POST" && url.pathname === "/net-api/turn") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        if (bearerSession && body.session === undefined) body.session = bearerSession;
        return await this.clientTurn(actor, body, identity.epoch, {
          ...(credential.kind === "apikey" ? { credential: credential.id } : {}),
          trace: adoptOrMintTraceContext(
            request.headers.get("traceparent"),
            request.headers.get("tracestate"),
            mintSampleDecision(spanSampleRate(this.env))
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
      if (request.method === "GET" && url.pathname === "/net-api/schedules") {
        /* CO16.9. "What has this room got armed, and what failed?" — the
           question authors and operators had no way to ask, which is why
           invisible timers were the largest gap in the scheduling surface.
           A LIVE read: the queue is not a cell and cannot be read inside a
           turn honestly (SC2), so this deliberately sits outside turn
           semantics and may be stale the moment it returns. */
        // The query names the ROOM the caller is in — `capi_room` — because
        // that is what presence reports and what a user can be expected to
        // know. The DO that holds the queue is addressed by its CO15 scope
        // name, `room:capi_room`. Authorizing on one and routing to the other
        // is the whole of this route's subtlety: an earlier cut authorized
        // the semantic id and then RPC'd it verbatim, reaching a DO that
        // holds nothing.
        const room = url.searchParams.get("scope") ?? "";
        if (!room) return json({ error: { code: "E_INVARG", message: "scope query param is required" } }, 400);
        const session = this.readSession(url, actor, bearerSession);
        // Same co-presence rule the other reads use: you can see what a room
        // has armed if you are in it. No global reads.
        if (!this.callerPresenceScopes(session, actor).has(room)) {
          throw new ClientAuthError("schedules not readable outside the caller's presence", { scope: room }, "E_PERM", 403);
        }
        const view = this.ensureView();
        const classifier = classifierFromLineage(
          (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
        );
        let routed: string;
        try {
          routed = classifier.scopeOf(room);
        } catch {
          throw new ClientAuthError("scope is not routable from this view", { scope: room }, "E_MISSING_STATE", 404);
        }
        const reply = await this.host.rpc(`scope:${routed}`, "/schedules");
        return json({ ...(reply as Record<string, unknown>), room });
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
        // AU1.2: an attempt that never committed still audits. The
        // principal names exactly what the boundary learned: nothing
        // (anonymous), a recognized-but-rejected credential
        // (credentialed), or an authenticated actor refused later
        // (rate/session refusals).
        // The specific verdict (unknown_or_revoked, missing_credential,
        // expired…) is the audit-valuable outcome; the coarse code is
        // recoverable from it.
        const reason =
          err.detail && typeof err.detail === "object" && typeof (err.detail as { reason?: unknown }).reason === "string"
            ? ((err.detail as { reason: string }).reason)
            : err.code;
        this.recordEdgeAudit(err.code === "E_RATE" ? "refusal" : "auth", reason, url.pathname, auditCredential, auditActor);
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

  /** Resolve a self-routing credential from the actor authority's private
   * verifier index. A small bounded cache amortizes the cross-DO hop; unlike
   * fanout it has an explicit revocation-staleness ceiling and stores no
   * enumerable relation state. The authority endpoint performs one indexed
   * lookup and returns the current mutation-complete head—no actor scan or
   * whole-scope transfer. Historical ids retain the carried catalog-map
   * compatibility path. */
  private async verifyClientApiKey(
    legacyMap: unknown,
    credential: ReturnType<typeof parseClientCredential>
  ): Promise<{ actor: string }> {
    if (credential.kind !== "apikey") {
      throw new ClientAuthError("credential is not an apikey", { reason: "unsupported_token_class" });
    }
    const routed = parseRoutedApiKeyId(credential.id);
    if (!routed) return verifyApiKeyCredential(legacyMap, credential);
    const scope = routedApiKeyScope(credential.id);
    if (!scope) throw new ClientAuthError("apikey not found or revoked", { reason: "unknown_or_revoked" });
    const answer = await this.routedApiKeyAuthorityRecord(scope, routed.actor, credential.id);
    const verified = verifyApiKeyRecord(answer.record, credential);
    if (verified.actor !== routed.actor) {
      throw new ClientAuthError("apikey record is malformed", { reason: "malformed_record" });
    }
    return verified;
  }

  /** Bounded O(1) verifier cache shared by initial authentication and
   * session-bearer revocation checks. Negative rows are cached too, so random
   * routed ids cannot amplify into unbounded authority traffic. */
  private readonly routedApiKeyCache = new Map<string, { checkedAt: number; record: unknown }>();

  private credentialTtlMs(): number {
    const raw = Number(this.env.NET_CREDENTIAL_TTL_MS);
    return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30_000) : 1_000;
  }

  /** Exact O(1) verifier read and receipt-shape validation. Transport
   * failures are availability errors, never "unknown credential": callers
   * may retry without mistaking a dead authority for revocation. */
  private async routedApiKeyAuthorityRecord(
    scope: string,
    actor: string,
    id: string
  ): Promise<{ record: unknown }> {
    const cacheKey = `${scope}\0${actor}\0${id}`;
    const now = this.host.now();
    const ttl = this.credentialTtlMs();
    const cached = this.routedApiKeyCache.get(cacheKey);
    if (cached && ttl > 0 && now >= cached.checkedAt && now - cached.checkedAt <= ttl) {
      // Refresh insertion order so the fixed-size map is LRU, not FIFO.
      this.routedApiKeyCache.delete(cacheKey);
      this.routedApiKeyCache.set(cacheKey, cached);
      return { record: cached.record };
    }
    let answer: {
      scope?: unknown;
      actor?: unknown;
      id?: unknown;
      head?: unknown;
      record?: unknown;
    };
    try {
      answer = (await this.host.rpc(`scope:${scope}`, "/credential-record", {
        actor,
        id
      })) as typeof answer;
    } catch {
      throw new ClientAuthError(
        "apikey authority is temporarily unavailable",
        { reason: "credential_authority_unavailable", retryable: true, scope },
        "E_RPC_TIMEOUT",
        503
      );
    }
    if (
      answer.scope !== scope ||
      answer.actor !== actor ||
      answer.id !== id ||
      !validScopeHead(answer.head)
    ) {
      throw new ClientAuthError("apikey authority returned an invalid receipt", {
        reason: "malformed_authority_receipt"
      });
    }
    this.routedApiKeyCache.delete(cacheKey);
    while (this.routedApiKeyCache.size >= 1_024) {
      const oldest = this.routedApiKeyCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.routedApiKeyCache.delete(oldest);
    }
    this.routedApiKeyCache.set(cacheKey, { checkedAt: now, record: answer.record });
    return { record: answer.record };
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
            this.persistCell(view, key, CATALOG_SCOPE);
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

  /** RPC name by which scopes reach this concrete gateway shard. The
   * environment value is only a legacy/test override; production derives
   * the destination from the named Durable Object id. */
  private selfDestination(): string | undefined {
    const shard = this.shardName();
    return this.env.NET_GATEWAY_SELF ?? (shard ? `gateway:${shard}` : undefined);
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
    const rosterRefusal = this.validateRosterVisibility(body, false);
    if (rosterRefusal) return rosterRefusal;
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
    const rosterRefusal = this.validateRosterVisibility(body, false);
    if (rosterRefusal) return rosterRefusal;
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
            this.persistCell(view, key, CATALOG_SCOPE);
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
          this.persistCell(view, key, CATALOG_SCOPE);
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
    // A fresh guest is born present at a FOREIGN room owner. The commit
    // durably queued the relation deltas, but the accepted response is also
    // the client's freshness fence: an immediate who/look must see this
    // session in the room authority's compact roster. Session-open and turn
    // transitions use the same fence. Omitting it here made a burst of
    // elastic claims temporarily look like unresolved room contents, which
    // both returned partial rosters and spent one presentation probe per
    // guest until the asynchronous outbox caught up.
    let relationExpediteDegraded = false;
    if (relateDestinations) {
      try {
        await this.expediteForeignRelations(reply, relateDestinations, []);
      } catch (err) {
        // Acceptance is already durable and the scope outbox retains the
        // exact same relation facts. Preserve success, but name the weaker
        // freshness guarantee just as sessionOpen does.
        relationExpediteDegraded = true;
        this.metric({
          kind: "net_relation_expedite_degraded",
          scope: reply.scope,
          status: "error",
          error: String(err)
        });
      }
    }
    let installDegraded = false;
    try {
      await this.installTouched(this.ensureView(), destination, reply.touched);
    } catch (err) {
      installDegraded = true;
      this.metric({ kind: "net_guest_provision_install_degraded", actor, status: "error", error: String(err) });
      this.installAcceptedSessionEcho(session, planned.value, reply, epoch, planned.clusterScope);
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
      ...(installDegraded ? { install_degraded: true } : {}),
      ...(relationExpediteDegraded ? { relation_expedite_degraded: true } : {})
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
      this.recordSessionCloseReceipt(session, actor);
      return json({ closed: true, already: verdict });
    }
    if (verdict !== "ok") {
      return json({ error: { code: "E_PERM", message: `session ${verdict}`, detail: { session_verdict: verdict } } }, 403);
    }
    const priorValue = cell?.value as {
      activeScope?: string | null;
      ephemeralActor?: boolean;
      rosterVisible?: false;
    } | undefined;
    const prior = priorValue?.activeScope ?? null;
    const opened = await this.sessionOpen({
      session,
      actor,
      ttl_ms: 0, // ignored in closing mode
      catalog_epoch: epoch,
      ...(priorValue?.rosterVisible === false ? { roster_visible: false } : {}),
      closing: { priorActiveScope: prior, ...(priorValue?.ephemeralActor ? { ephemeralActor: true } : {}) }
    });
    if (opened.reply.status !== "accepted") {
      return json({ error: { code: "E_RETRY", message: "session close did not commit; retry", detail: opened.reply } }, 503);
    }
    // Record only after authority accepted the close. It is gateway-local
    // retry evidence, allowing the now-invalid bearer to repeat DELETE if the
    // edge reply is lost; it is never consulted for ordinary authentication.
    this.recordSessionCloseReceipt(session, actor);
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
    // Ownership is serialized into the object_lineage cell (src/net/bridge.ts),
    // not a property_cell — a `property_cell:<obj>:owner` is never emitted, so
    // owner MUST be read from lineage. Reading it via `prop(obj, "owner")` would
    // always resolve nothing and refuse every non-$wiz-owned agent.
    const lineage = (object: string): { parent?: string | null; owner?: string } | undefined =>
      this.ensureView().get(cellKey("object_lineage", object))?.value as {
        parent?: string | null;
        owner?: string;
      } | undefined;
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
      // owner disqualifies its agents. Ownership is object-lineage metadata,
      // not a Woo property cell: reading property_cell:<agent>:owner made
      // every real Net agent fail closed as "owner unresolved".
      // $wiz-owned agents authenticate.
      if (reachesClass(current, "$agent")) {
        const owner = lineage(current)?.owner;
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
    options: {
      exclusive?: boolean;
      session?: string;
      issuedAt?: number;
      ttlMs?: number;
      apiKeyId?: string;
    } = {}
  ): Promise<Response> {
    const rosterRefusal = this.validateRosterVisibility(body, Boolean(options.apiKeyId));
    if (rosterRefusal) return rosterRefusal;
    const requestedRosterVisibility = body.roster_visible;
    const rosterVisible = requestedRosterVisibility !== false;
    // The mint needs the actor's lineage (cluster-scope derivation) in view. A
    // self-routing apikey names the actor's home cluster directly — an anchored
    // agent's cells live in its authority root's cluster, NOT `cluster:<agent>`,
    // so the CO15 `cluster:<actor>` convention would warm an empty scope and
    // sessionOpen would fail E_MISSING_STATE. Fall back to that convention for
    // legacy/unrouted keys (an unanchored actor IS its own cluster root).
    const homeScope = (options.apiKeyId && routedApiKeyScope(options.apiKeyId)) || `cluster:${actor}`;
    await this.warmScopes(
      [CATALOG_SCOPE, { scope: homeScope, objects: [actor] }],
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
      ...(options.apiKeyId ? { apikey_id: options.apiKeyId } : {}),
      ...(!rosterVisible ? { roster_visible: false } : {}),
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
      roster_visible: rosterVisible,
      ...(opened.install_degraded ? { install_degraded: true } : {}),
      ...(opened.relation_expedite_degraded ? { relation_expedite_degraded: true } : {})
    });
  }

  /** Validate the roster policy before login derivation, guest allocation,
   * or authority writes. Human door sessions cannot hide themselves; only
   * an already-authenticated API-key service principal may opt out. */
  private validateRosterVisibility(body: Record<string, unknown>, allowHidden: boolean): Response | null {
    const requested = body.roster_visible;
    if (requested !== undefined && typeof requested !== "boolean") {
      return json(
        {
          error: {
            code: "E_INVARG",
            message: "roster_visible must be boolean",
            detail: { roster_visible: requested }
          }
        },
        400
      );
    }
    if (requested === false && !allowHidden) {
      return json(
        {
          error: {
            code: "E_PERM",
            message: "hidden-roster sessions require API-key authentication",
            detail: { reason: "roster_visibility_requires_apikey" }
          }
        },
        403
      );
    }
    return null;
  }

  /** POST /net-api/turn — see the clientApi header. */
  private async clientTurn(
    actor: string,
    body: Record<string, unknown>,
    epoch: string,
    audit?: { credential?: string; trace?: TraceContext }
  ): Promise<Response> {
    // CO14 Phase-4 rule: client-originated turns REQUIRE a session. The
    // gateway refuses session-less turns up front (named). Both direct and
    // sequenced calls carry the session read, so the committing scope still
    // revalidates it end-to-end. The planning-scope override below forces
    // direct for a cluster root and keeps the requested route for a room.
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
    // The client may request an explicit route; the default is sequenced. The
    // planning-scope override below tightens this per topology (a cluster root
    // cannot host an in-world sequencer), while a room preserves the explicit
    // direct request (metadata-gated by direct_callable further down).
    const requestedRoute = body.route === undefined ? "sequenced" : body.route;
    if (requestedRoute !== "direct" && requestedRoute !== "sequenced") {
      return json({ error: { code: "E_INVARG", message: "turn route must be direct or sequenced" } }, 400);
    }
    let route: "direct" | "sequenced" = requestedRoute;
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
    // Planning-scope route override (topology tightens the client's request):
    // a private authority CLUSTER must invoke DIRECT — the committing Scope head
    // sequences it, and a cluster root is an actor, not a $space with
    // next_seq/subscribers/presence, so it cannot host an in-world sequencer. A
    // shared ROOM keeps the requested route: sequenced by default, but an
    // explicit direct request is honored (and still metadata-gated by
    // direct_callable below, and re-enforced by world.directCall). Catalog (or
    // any other classification) is not client-plannable and is refused, never
    // silently coerced into either route.
    if (planningScope.startsWith("cluster:")) {
      route = "direct";
    } else if (!planningScope.startsWith("room:")) {
      return json({ error: { code: "E_INVARG", message: "client turn cannot plan at this scope", detail: { field: "scope", reason: "unplannable_scope", scope: planningScope } } }, 400);
    }
    const targetAuthorityScope = this.clientTargetAuthorityScope(target, anchorObject, actor, planningScope);
    // Phase 4: warm the TURN'S TARGET at its own authority and the anchor
    // at the planning scope. A room relation may contain a self-hosted
    // fixture whose cells belong to a cluster scope; treating the room as
    // the target's authority works only after another request happens to
    // warm the fixture. The relation's install/fanout-owned member_scope
    // is the cold routing fact. It grants no permission: normal verb,
    // presence, read, and committing-scope checks still run below.
    const targetWarmEntries =
      targetAuthorityScope === planningScope
        ? [{ scope: planningScope, objects: [target, anchorObject] }]
        : [
            { scope: targetAuthorityScope, objects: [target] },
            { scope: planningScope, objects: [anchorObject] }
          ];
    await this.warmScopes(
      targetWarmEntries,
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
      route,
      scope: anchorObject,
      session,
      actor,
      target,
      verb,
      args
    } as const;
    let page = this.callVerbPage(this.ensureView(), validationCall);
    // A relation/room closure may have installed only the target's lineage
    // stub. That is enough to route the object but not enough to authorize a
    // direct call: missing metadata must still fail closed, while a cold but
    // valid target gets one bounded owner pull before the decision. Without
    // this step the first direct call to a previously listed room member is
    // spuriously E_DIRECT_DENIED forever (warmScopes sees the lineage and
    // quite correctly avoids re-pulling the whole object).
    if (route === "direct" && page === null) {
      try {
        await this.pullTargeted(targetAuthorityScope, `scope:${targetAuthorityScope}`, [target]);
        page = this.callVerbPage(this.ensureView(), validationCall);
      } catch (err) {
        this.metric({
          kind: "net_direct_metadata_pull_failed",
          scope: targetAuthorityScope,
          target,
          verb,
          status: "error",
          error: String(err)
        });
      }
    }
    // A targeted room backfill can materialize an object's lineage without
    // every definition page. Only suspicious colon-bearing inputs pay for a
    // forced object closure; ordinary turns retain the warm zero-RPC path.
    // This also resolves inherited verb metadata through the returned chain.
    if (!page && args.some((value) =>
      (Array.isArray(value) ? value : [value]).some((part) => typeof part === "string" && part.includes(":"))
    )) {
      try {
        await this.pullTargeted(targetAuthorityScope, `scope:${targetAuthorityScope}`, [target]);
        page = this.callVerbPage(this.ensureView(), validationCall);
      } catch (err) {
        this.metric({
          kind: "net_client_arg_validation_pull_failed",
          scope: targetAuthorityScope,
          status: "error",
          error: String(err)
        });
      }
    }
    // External direct dispatch is metadata-gated at the ingress boundary
    // (core.md C12.2). Missing metadata fails closed: a sparse gateway must
    // never turn an unresolved verb into permission to bypass sequencing.
    if (route === "direct" && page?.direct_callable !== true) {
      return json(
        {
          error: {
            code: "E_DIRECT_DENIED",
            message: `verb ${verb} is not externally direct-callable`,
            detail: { target, verb }
          }
        },
        403
      );
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
      route,
      scope: anchorObject,
      session,
      actor,
      target,
      verb,
      args
    }, planningScope);
    // Client retries reuse their supplied idempotency key (CO2.5); an
    // unkeyed request gets a fresh turn identity.
    const suppliedKey =
      typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
        ? body.idempotency_key
        : null;
    const key = suppliedKey ?? `napi:${randomHex(12)}`;
    // CO2.5 receipt opt-in. Supplying a key is NOT the signal on its own:
    // the browser mints a fresh uuid per turn (net-feed.ts) and never reuses
    // it, so treating that as an opt-in would add a storage write to every
    // view refresh — exactly the cost the effect-free direct path avoids.
    // `retry_safe` is the explicit statement "this key is stable and I will
    // reuse it"; MCP sets it from an `operation_id`.
    const retryReceipt = suppliedKey !== null && body.retry_safe === true;
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
        typeof bodyTrace?.tracestate === "string" ? bodyTrace.tracestate : null,
        mintSampleDecision(spanSampleRate(this.env))
      );
    const result = await this.turn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: key,
        route,
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
      idempotency_key: key,
      ...(retryReceipt ? { retry_receipt: true } : {})
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
    try {
      const identity = await this.catalogIdentity();
      const boundActor = await this.authorizedActorForSessionBearer(session, identity.map);
      if (boundActor !== actor) {
        throw new ClientAuthError("authenticated actor does not match session", {
          reason: "actor_mismatch"
        });
      }
    } catch (error) {
      return json({
        error: {
          code: "E_NOSESSION",
          message: error instanceof Error ? error.message : String(error)
        }
      }, 401);
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
    const location = typeof live?.location === "string" && live.location.length > 0 ? live.location : null;
    // A located-nowhere actor plans at its OWN cluster (CO14). `$nowhere` is the
    // catalog-scoped universal home, and any `$`-prefixed location is
    // catalog-delivered seed substrate — neither is a plannable anchor, so fall
    // back to the actor itself rather than routing the turn into the catalog
    // scope (which is not client-plannable).
    if (!location || location.startsWith("$")) return actor;
    return location;
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

  /**
   * Resolve a cold client target through the bounded structural context the
   * caller already has. `contents.member_scope` is derived by the authority
   * classifier when the relation is written, so it is the only exact routing
   * fact available before the target's lineage is materialized locally.
   *
   * This is deliberately not a global lookup and not an authorization rule:
   * only the active anchor and the actor's inventory are searched, and the
   * resulting scope merely selects which authority to pull before the normal
   * planner and permission checks execute.
   */
  private clientTargetAuthorityScope(
    target: string,
    anchorObject: string,
    actor: string,
    planningScope: string
  ): string {
    for (const owner of new Set([anchorObject, actor])) {
      const row = this.relationMembers("contents", owner).find((candidate) => candidate.member === target);
      if (row?.member_scope) return row.member_scope;
    }
    const view = this.ensureView();
    if (view.has(cellKey("object_lineage", target))) {
      const classifier = classifierFromLineage(
        (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
      );
      try {
        return classifier.scopeOf(target);
      } catch {
        // An incomplete cached lineage chain is not a routing grant. The
        // planning scope remains the conservative repair-loop fallback.
      }
    }
    return planningScope;
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
    if (rpc.id === undefined || rpc.id === null) {
      return await this.mcpNotification(request, rpc.method, mcpRecord(rpc.params));
    }
    if (rpc.method === "initialize") return await this.mcpInitialize(request, rpc.id, rpc.params ?? {});
    if (rpc.method === "tools/list") return await this.mcpToolsList(request, rpc.id, rpc.params ?? {});
    if (rpc.method === "tools/call") {
      return await this.mcpToolsCall(request, rpc.id, rpc.params ?? {});
    }
    return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } }, 200);
  }

  /**
   * Post-initialize JSON-RPC notifications (no `id`): acknowledged with 202
   * and no body, per Streamable HTTP.
   *
   * AUTHENTICATED AND RATE-LIMITED FIRST (mcp.md M1.1). Every non-initialize
   * method validates the session; a notification is a method. The blanket 202
   * that used to precede this check meant an anonymous caller could drive
   * `notifications/*` — including the unknown ones an evolving protocol
   * brings — through the DO at whatever rate it liked, entirely outside the
   * per-actor bucket, and could act on a raw `mcp-session-id` header without
   * its expiry ever being consulted. Both are refused here now, on exactly
   * the same terms as `tools/call`.
   *
   * `initialize` keeps its own path: it is a REQUEST that carries the
   * `mcp-token` credential and mints the session this check reads.
   */
  private async mcpNotification(
    request: Request,
    method: string,
    params: Record<string, unknown>
  ): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    // Both throws are ClientAuthError, which clientApi's catch renders as the
    // standard client refusal envelope (401 for a rejected session bearer,
    // 429 for E_RATE) and records as an AU1.2 edge audit. A notification has
    // no id to correlate a JSON-RPC error against, so the HTTP status is the
    // whole answer — and it must not be 202.
    const actor = await this.mcpSessionActor(session);
    this.enforceClientRate(actor, "/net-api/mcp");
    if (method === "notifications/cancelled") {
      const requestId = params.requestId;
      // Now that the session is proven, cancellation still only ever releases
      // a waiter parked under THIS session id, and releasing one drains
      // nothing. Keyed by CLASS as well as value: JSON-RPC ids `1` and `"1"`
      // are different ids, so `"1"` must not release a wait parked under `1`.
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.mcpCancelWait(session, mcpRequestKey(requestId));
      }
    }
    // Unknown notification methods are still ignored — a notification carries
    // no id to answer with `method not found`, and an evolving client must be
    // able to send one harmlessly. It reaches here only after paying for the
    // session check and a rate token.
    return new Response(null, { status: 202 });
  }

  /**
   * Streamable HTTP's optional standalone GET/SSE carrier. The listen is
   * deliberately bounded: an idle Durable Object request must not become a
   * permanent synchronous dependency. Standard clients reconnect after the
   * stream closes, while a not-yet-delivered hint remains pending in the
   * session state and is handed to exactly one later stream.
   *
   * BOUNDED PER SESSION (MCP_MAX_SESSION_SSE, mcp.md M6), and bounded by
   * REPLACEMENT rather than refusal. Admitting a listen over the cap closes
   * the oldest one instead of rejecting the new one, because the excess this
   * has to survive is not usually abuse: an ungracefully dropped connection
   * leaves a phantom waiter behind — `cancel()` is not guaranteed to fire
   * promptly — and refusing would then lock a legitimately reconnecting
   * client out for up to a full 25-second listen window. An evicted stream
   * ends normally (the `retry:` field already told the client to reconnect),
   * so replacement costs a reconnect while refusal costs availability. There
   * is consequently NO new refusal status on this path; a client cannot
   * provoke more than MCP_MAX_SESSION_SSE live listens no matter how many
   * GETs it sends, and their arrival RATE is what `enforceClientRate` bounds.
   *
   * Nothing is lost by an eviction: `listChangedPending` is only cleared by a
   * delivery that a stream actually accepted, so a pending hint survives to
   * the next stream.
   */
  private async clientMcpEvents(request: Request): Promise<Response> {
    const accept = request.headers.get("accept") ?? "";
    if (!accept.toLowerCase().includes("text/event-stream")) {
      return json({ error: { code: "E_INVARG", message: "MCP GET requires Accept: text/event-stream" } }, 406);
    }
    const session = request.headers.get("mcp-session-id") ?? "";
    let actor: string;
    try {
      actor = await this.mcpSessionActor(session);
    } catch (error) {
      const auth = error instanceof ClientAuthError ? error : null;
      return json(
        {
          error: {
            code: auth?.code ?? "E_NOSESSION",
            message: auth?.message ?? (error instanceof Error ? error.message : String(error)),
            ...(auth ? { detail: auth.detail } : {})
          }
        },
        auth?.code === "E_NOSESSION" ? 404 : (auth?.status ?? 404)
      );
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
        // Make room before admitting. `close()` splices the evicted waiter out
        // of `sseWaiters` itself, so the loop always makes progress; the guard
        // on `length` (rather than a fixed count) tolerates a waiter that
        // closed concurrently.
        while (state.sseWaiters.length >= MCP_MAX_SESSION_SSE) {
          const evicted = state.sseWaiters[0];
          evicted.close();
          if (state.sseWaiters[0] === evicted) state.sseWaiters.shift();
        }
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
    if (credential.kind !== "apikey") {
      throw new ClientAuthError("MCP initialize requires an apikey", {
        reason: "unsupported_token_class"
      });
    }
    const identity = await this.catalogIdentity();
    const { actor } = await this.verifyClientApiKey(identity.map, credential);
    this.enforceClientRate(actor, "/net-api/session"); // the mint bucket (H4 amplifier rule)
    const opened = await this.clientSession(actor, {}, identity.epoch, { apiKeyId: credential.id });
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
          // This string is an agent's ENTIRE onboarding: many MCP clients
          // never call anything they were not pointed at. Two sentences of
          // orientation cost nothing and remove the "what now?" turn.
          //
          // `mcpSanitizeId(actor)__help` is the canonical name here without a
          // lookup: mcpToolsForObjects sorts the session actor ahead of every
          // other contextual object, so the actor's descriptors are named
          // first and never carry a collision suffix (M2.3). Any OTHER
          // object's tool must be read from the canonical listing instead —
          // see mcpAdvertisedName.
          instructions: `You are woo actor ${actor}. Dynamic tools track your current space, its contextual objects, and your inventory. Re-list tools when notifications/tools/list_changed arrives. Start with ${mcpSanitizeId(actor)}__help for orientation — with no topic it returns the index. Use woo_wait to hear what other actors do, and woo_list_reachable_tools to page or search the dynamic surface.`
        }
      },
      200,
      { "mcp-session-id": body.session }
    );
  }

  /** MCP carries the Net session id after initialize and deliberately does
   * not replay the long-lived API-key secret. Reuse session-bearer validation
   * and fetch the legacy registry only for an aged, non-self-routing key. */
  private async mcpSessionActor(session: string): Promise<string> {
    const value = this.ensureView().get(sessionCellKey(session))?.value as {
      apikeyId?: unknown;
    } | undefined;
    const id = typeof value?.apikeyId === "string" ? value.apikeyId : null;
    const legacyMap = id && !parseRoutedApiKeyId(id)
      ? (await this.catalogIdentity()).map
      : undefined;
    return await this.authorizedActorForSessionBearer(session, legacyMap);
  }

  /** AU2: adopt the MCP request's traceparent for a tool-invoked turn. */
  private mcpTraceOf(request: Request): TraceContext {
    return adoptOrMintTraceContext(
      request.headers.get("traceparent"),
      request.headers.get("tracestate"),
      mintSampleDecision(spanSampleRate(this.env))
    );
  }

  private async mcpToolsCall(request: Request, id: number | string, params: Record<string, unknown>): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    let actor: string;
    try {
      actor = await this.mcpSessionActor(session);
    } catch (error) {
      const auth = error instanceof ClientAuthError ? error : null;
      return json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: auth?.message ?? (error instanceof Error ? error.message : String(error)),
          ...(auth ? { data: { code: auth.code, detail: auth.detail, http_status: auth.status } } : {})
        }
      }, 200);
    }
    this.mcpSessionState(session, actor, true);
    this.enforceClientRate(actor, "/net-api/mcp");
    const name = typeof params.name === "string" ? params.name : "";
    // M4.3: validate the ROOT value before treating it as a property bag.
    // `(params.arguments ?? {})` cast a string, an array, a number, or an
    // explicit `null` straight through as though it were an empty object, so
    // a control with no required properties silently ran on its defaults —
    // the same silent-substitution class as the `Array.isArray(args) ? args :
    // []` bug this validation already closed for woo_call, one level up.
    //
    // ABSENT stays legal: MCP declares `arguments` optional. It is only the
    // supplied-but-not-an-object case that is refused, `null` included —
    // MCP's own CallToolRequest declares the field optional, not nullable,
    // and "no arguments" is spelled by omitting it. (Our OWN optional
    // parameters are advertised as nullable and do accept `null`; the
    // difference is that this envelope's schema is MCP's to define, not
    // ours.)
    const suppliedArguments = params.arguments;
    if (suppliedArguments !== undefined && !isMcpArgumentObject(suppliedArguments)) {
      return this.mcpToolError(id, {
        code: "E_INVARG",
        message: `${name || "tools/call"}: "arguments" must be a JSON object of named parameters, received ${mcpJsonTypeOf(suppliedArguments)}`,
        detail: {
          reason: "invalid_arguments_object",
          tool: name,
          field: "arguments",
          expected: "object",
          received: mcpJsonTypeOf(suppliedArguments),
          remediation: "pass arguments as a JSON object keyed by parameter name, or omit it entirely when the tool takes none"
        }
      });
    }
    const args = (suppliedArguments ?? {}) as Record<string, unknown>;

    if (name === "woo_wait") {
      // M4.3: the advertised schema is enforced before anything else happens.
      // Silently defaulting a wrong-typed `timeout_ms` made a client that
      // passed "5000" park for one second and believe it had parked for five.
      const refusal = mcpValidateNamedArguments(name, MCP_CONTROL_SCHEMAS[name], args);
      if (refusal) return this.mcpToolError(id, refusal);
      const timeout = typeof args.timeout_ms === "number" ? Math.min(Math.max(args.timeout_ms, 0), 25_000) : 1000;
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.max(Math.floor(args.limit), 1), MCP_QUEUE_CAP)
        : 64;
      const drained = await this.mcpWait(session, actor, timeout, limit, mcpRequestKey(id));
      if ("refused" in drained) return this.mcpToolError(id, drained.refused);
      return this.mcpResult(id, { observations: drained.observations, gap: drained.gap });
    }
    // The relation mirror can be newer than this gateway's object-cell view.
    // Materialize only the bounded structural context before discovery or
    // invocation so the advertised set and the accepted set remain equal.
    await this.warmMcpContext(actor, session);
    if (name === "woo_list_reachable_tools") {
      // M4.3. The `scope` enum is now refused by the same validator every
      // other tool uses, so the refusal names the field and the allowed set
      // instead of arriving as a bare thrown message. mcpToolScope still
      // guards the internal contract for non-transport callers.
      const refusal = mcpValidateNamedArguments(name, MCP_CONTROL_SCHEMAS[name], args);
      if (refusal) return this.mcpToolError(id, refusal);
      try {
        const page = this.mcpToolPage(actor, session, args);
        // Re-baseline from the canonical set the page was projected from —
        // the same descriptors tools/list would render, so a discovery call
        // never records a digest that disagrees with the standard listing.
        this.mcpMarkToolListSeen(session, actor, this.mcpToolListDigest(actor, session, page.canonical, page.context));
        const includeSchema = args.include_schema === true;
        return this.mcpResult(id, {
          scope: page.scope,
          active_scope: page.activeScope,
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
      // M4.3, gate 1: woo_call's OWN schema — `object`/`verb` required
      // non-empty strings, `args` an array. This replaced a coercing presence
      // check that reported a non-string `object` as "missing" and silently
      // turned a non-array `args` into an empty list, dispatching the verb
      // with no arguments instead of saying the payload was malformed.
      //
      // The non-empty rule is the schema's advertised `minLength: 1`, not a
      // separate hand-rolled branch: it used to be enforced here and
      // published nowhere, so a client that satisfied the printed schema
      // could still be refused.
      //
      // The operation id is adjudicated FIRST, and deliberately. It rides two
      // carriers (`_meta` and `arguments`, §M4.2) and only one of them has a
      // published schema, so letting the generic validator reach it first
      // would report the SAME malformed value under two different
      // `detail.reason`s depending on which carrier a client happened to use.
      // mcpOperationId enforces `MCP_OPERATION_ID_PATTERN` — the same regex
      // the schema publishes — so the accepted set is identical either way;
      // this only fixes which refusal a client is told about.
      // `woo_call` carries verb arguments positionally inside `args`, so its
      // own argument namespace never collides with the reserved name.
      const operation = mcpOperationId(params, args, []);
      if (!operation.ok) return this.mcpToolError(id, operation.error);
      const controlRefusal = mcpValidateNamedArguments(name, MCP_CONTROL_SCHEMAS[name], args);
      if (controlRefusal) return this.mcpToolError(id, controlRefusal);
      const requested = args.object as string;
      const verb = args.verb as string;
      // `$me`/`$here` are the forms every user doc uses for "the session
      // actor" and "the space I am in". They resolved nowhere, so each of
      // those documented examples refused. They are transport-level session
      // aliases — no world object is named `$me` or `$here` — and resolving
      // them here keeps the world's own id vocabulary untouched.
      const object = requested === "$me"
        ? actor
        : requested === "$here"
          ? (this.mcpActiveScope(actor, session) ?? requested)
          : requested;
      if (requested === "$here" && object === requested) {
        return this.mcpToolError(id, {
          code: "E_PERM",
          message: "$here does not resolve: this session has no active space",
          detail: { reason: "no_active_scope", actor, remediation: "enter a space first" }
        });
      }
      if (!isConcreteRuntimeObjectId(object)) {
        return this.mcpToolError(id, { code: "E_INVARG", message: "target must be a concrete runtime object id", detail: { field: "target", reason: "invalid_object_id", value: object } });
      }
      const resolved = this.mcpResolveCall(actor, session, object, verb);
      if ("error" in resolved) return this.mcpToolError(id, resolved.error);
      // M4.3, gate 2: the resolved verb's own declared parameters. `woo_call`
      // cannot advertise them — its schema describes a free-form list — but
      // once the verb is resolved its `arg_spec` is in hand, and it is the
      // SAME input the advertised dynamic `inputSchema` is derived from.
      const positional = Array.isArray(args.args) ? args.args : [];
      const argRefusal = mcpValidatePositionalArguments(
        resolved.tool.object,
        resolved.tool.verb,
        resolved.tool.argSpec,
        positional
      );
      if (argRefusal) return this.mcpToolError(id, argRefusal);
      return this.mcpInvokeTurn(
        id,
        actor,
        session,
        resolved.tool.object,
        resolved.tool.verb,
        positional,
        resolved.tool.route,
        this.mcpTraceOf(request),
        operation.value
      );
    }
    const dynamic = this.mcpContextTools(actor, session).find((tool) => tool.name === name);
    if (dynamic) {
      // The operation id goes first for the carrier-uniformity reason spelled
      // out in the woo_call branch above.
      const operation = mcpOperationId(params, args, dynamic.argNames);
      if (!operation.ok) return this.mcpToolError(id, operation.error);
      // M4.3: validate against `mcpProtocolTool`'s schema — the exact object
      // `tools/list` advertised for this tool, reserved `operation_id`
      // included — so the accepted set and the advertised set are one thing.
      const refusal = mcpValidateNamedArguments(name, mcpProtocolTool(dynamic).inputSchema, args);
      if (refusal) return this.mcpToolError(id, refusal);
      return this.mcpInvokeTurn(
        id,
        actor,
        session,
        dynamic.object,
        dynamic.verb,
        mcpNamedArgs(dynamic, args),
        dynamic.route,
        this.mcpTraceOf(request),
        operation.value
      );
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } }, 200);
  }

  /** Standard MCP tools/list. Dynamic descriptors are computed from the same
   * bounded structural-context resolver used by woo_call, so listing and
   * invocation cannot disagree about reachability. */
  private async mcpToolsList(request: Request, id: number | string, params: Record<string, unknown>): Promise<Response> {
    const session = request.headers.get("mcp-session-id") ?? "";
    let actor: string;
    try {
      actor = await this.mcpSessionActor(session);
    } catch (error) {
      const auth = error instanceof ClientAuthError ? error : null;
      return json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: auth?.message ?? (error instanceof Error ? error.message : String(error)),
          ...(auth ? { data: { code: auth.code, detail: auth.detail, http_status: auth.status } } : {})
        }
      }, 200);
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
    route: "direct" | "sequenced",
    trace?: TraceContext,
    operationId?: string | null
  ): Promise<Response> {
    try {
      const identity = await this.catalogIdentity();
      // CO2.5 / mcp.md §M4.2. A client-supplied operation id makes the turn
      // key STABLE across retries, so a retry after a lost response replays
      // the authority's recorded reply instead of committing a second time.
      // Namespaced by actor: the id is client-chosen, and two agents that
      // both pick "op-1" must not collide into each other's turns. Without
      // an id the key is freshly minted — the pre-existing behaviour, which
      // is safe for reads and unsafe for mutations, hence the advertisement
      // on every tool schema.
      const turnId = operationId ? `mcp:${actor}:${operationId}` : `mcp:${crypto.randomUUID()}`;
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
        {
          target: object,
          verb,
          args,
          route,
          session,
          idempotency_key: turnId,
          // CO2.5: an operation id is a promise the client will reuse this
          // key, so an effect-free but externally visible turn (speech)
          // records a receipt and its retry cannot emit the act twice. The
          // minted fallback key sets nothing — it is never reused.
          ...(operationId ? { retry_safe: true } : {})
        },
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
        observations?: unknown;
        replayed?: unknown;
        replay_outcome?: unknown;
        replay_omitted?: unknown;
        [key: string]: unknown;
      };
      // CO2.5: a replay carries the committed execution's outcome plus the
      // markers that say how much of it survived retention. `result` is
      // omitted (not `null`) when the outcome exists but was not retained,
      // so a client can tell "returned nothing" from "cannot show you".
      // Computed BEFORE the failure branches: a replayed FAILURE is still a
      // replay, and the client needs to know it did not just re-run.
      const replay = turn.replayed === true
        ? {
            replayed: true as const,
            outcome: typeof turn.replay_outcome === "string" ? turn.replay_outcome : "none",
            ...(Array.isArray(turn.replay_omitted) ? { omitted: turn.replay_omitted } : {})
          }
        : undefined;
      const shape = (failure: unknown, observations?: unknown[]): Response =>
        this.mcpToolError(id, this.mcpShapeTurnError(failure, actor, session, object), observations, replay);
      // A transport failure and a rejected commit never executed a verb, so
      // there are no own-turn observations to carry.
      if (!turnResponse.ok) return shape(turn.error ?? turn);
      if (turn.reply?.status !== "accepted") return shape(turn.reply ?? turn);
      // An ACCEPTED commit whose verb THREW is a failure that still ran: its
      // transcript committed, and it may have emitted lines before throwing.
      // Those lines are the submitter's ONLY copy — the gateway suppresses
      // its own committed echo from woo_wait precisely because the reply is
      // supposed to carry them (§M4.1) — so returning early here dropped
      // them on the floor and left an MCP actor unable to see what its own
      // failed action did. A replayed failure replays the RECORDED lines.
      if (turn.error !== undefined) {
        return shape(turn.error, this.mcpOwnTurnObservations(turn.observations, actor));
      }
      const resultKnown = !(replay !== undefined && turn.result === undefined && replay.outcome !== "full");
      return this.mcpResult(
        id,
        turn.result ?? null,
        this.mcpOwnTurnObservations(turn.observations, actor),
        replay,
        resultKnown
      );
    } catch (err) {
      // Taxonomy throws are tool failures on this surface. The JSON-RPC
      // request must receive a tool envelope, never an HTTP transport error.
      if (isNetError(err)) {
        return this.mcpToolError(
          id,
          this.mcpShapeTurnError({ code: err.code, message: err.message, detail: err.detail }, actor, session, object)
        );
      }
      return this.mcpToolError(id, { code: "E_INTERNAL", message: String(err) });
    }
  }

  /**
   * Client-facing shaping for a refused turn. Engine-true refusals are not
   * automatically agent-legible: "write set spans two distinct shared
   * scopes" is exactly right and tells an agent nothing about what to do.
   *
   * The coherence rule itself is untouched — a turn whose write set spans two
   * shared scopes is still terminal (CO2.3). This only adds the remediation
   * an MCP client can act on: the target is a mounted space you have not
   * entered, so enter it. That is the "move to use" rule the space model
   * already enforces; naming it is what was missing.
   */
  private mcpShapeTurnError(failure: unknown, actor: string, session: string, target: string): unknown {
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return failure;
    const record = failure as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : typeof record.reason === "string" ? record.reason : "";
    // CO2.5 / M4.2: key reuse for a DIFFERENT call. This needs its own code,
    // not a generic argument error: the client's arguments are fine — what
    // is wrong is that it reused an operation id, and only a specific code
    // tells it which of the two to change. Nothing about the original call
    // is echoed; the holder of a colliding key must not learn it.
    if (code === "idempotency_conflict") {
      const detail = mcpRecord(record.detail);
      return {
        code: "E_IDEMPOTENCY_CONFLICT",
        message: "this operation_id was already used for a different call",
        detail: {
          ...detail,
          reason: "operation_id_reused",
          remediation:
            "if you meant to retry the earlier call, send it again UNCHANGED under this operation_id; "
            + "if this is a new operation, give it a new operation_id"
        }
      };
    }
    if (code !== "E_SCOPE_SPLIT") return failure;
    const active = this.mcpActiveScope(actor, session);
    if (target === active) return failure; // already standing in the target
    const detail = mcpRecord(record.detail);
    return {
      ...record,
      detail: {
        ...detail,
        active_scope: active,
        target,
        // The target is reachable (it was resolved from structural context)
        // but writes at its own shared scope, so presence has to move there.
        // The tool name is read from the canonical listing rather than
        // re-derived by sanitizing the id: with collision suffixes in play a
        // re-derived guess can name a DIFFERENT object's tool (M2.3).
        remediation:
          `${target} is a separate shared scope from ${active ?? "your current position"}; ` +
          `one turn cannot write both. Enter ${target} first — call ` +
          `${this.mcpAdvertisedName(actor, session, target, "enter") ?? `${target}:enter`}, ` +
          `or the movement verb that leads there — then retry, and re-list tools afterwards.`
      }
    };
  }

  /**
   * The submitting session's seat for its OWN turn's observations.
   *
   * The gateway has always held this contract for the socket transports —
   * `recentClientTurns` skips the submitter's sockets on the fanout precisely
   * because "the submitting session receives its turn's observations on the
   * turn reply". `/net-api/turn` honours it; the MCP envelope was the one
   * transport that read `result`/`error` off that reply and dropped
   * `observations` on the floor. Composed with the queue's echo dedupe (which
   * stays exactly as it is, so nothing arrives twice), an MCP actor therefore
   * never saw what its own action did — guest_2 walked out of the room and
   * never read its own "You slide the glass door open…" line.
   *
   * Delivering them on the reply rather than through `woo_wait` is the
   * deliberate choice: it pairs cause with effect in one round trip, which is
   * what a turn-based agent needs, and it keeps `woo_wait` meaning exactly
   * "what OTHER actors did".
   *
   * Directed lines addressed to somebody else are dropped. This deliberately
   * does NOT reuse `observationReachesActor` (src/core/types.ts): that
   * predicate answers the FANOUT question "may this actor hear this?", and for
   * `text` it sets `from: null` — the sender gets no echo. This seat answers a
   * different question, "what did my own turn emit?": the submitter's outbound
   * tell lines belong in the reply even though delivery would never echo them.
   * The only exclusion is a row explicitly `to`-addressed to a different actor.
   */
  private mcpOwnTurnObservations(observations: unknown, actor: string): unknown[] {
    if (!Array.isArray(observations)) return [];
    return observations.filter((observation) => {
      const to = (observation as { to?: unknown } | null)?.to;
      return typeof to !== "string" || to === actor;
    });
  }

  /** The scenario's client contract: payloads ride
   * `result.structuredContent.result`; errors set `isError` with the
   * detail in structuredContent (unwrap() throws on it).
   *
   * `observations` is a SIBLING of `result`, never nested inside it: the
   * payload is the verb's own return value and may be any JSON — a scalar,
   * null — so there is nowhere inside it to put anything. Existing consumers
   * read `structuredContent.result` and are unaffected. A second content
   * block carries the same rows for text-rendering clients, which would
   * otherwise never see them; the first block keeps its exact former shape.
   *
   * The field is present only for VERB INVOCATIONS — the protocol controls
   * pass nothing, because a `woo_wait` reply carrying both its drained queue
   * and an always-empty `observations` sibling would be actively misleading.
   *
   * `replay` (CO2.5, §M4.2) marks a result that came from the authority's
   * RECORD of an earlier commit under the same operation id rather than from
   * a fresh execution. It is not decoration: an agent that cannot tell the
   * two apart will either re-run a committed mutation or believe a stale
   * outcome. `resultKnown:false` drops `result` entirely rather than
   * reporting `null`, and the prose block spells out the one action a client
   * must NOT take — retry under a new id.
   */
  private mcpResult(
    id: number | string,
    payload: unknown,
    observations?: unknown[],
    replay?: { replayed: true; outcome: string; omitted?: unknown[] },
    resultKnown = true
  ): Response {
    const notice = replay === undefined
      ? null
      : replay.outcome === "full"
        ? "This is a replay: the operation had already committed under this operation_id, and this is its recorded outcome. "
          + "It ran exactly once. Do not retry it under a new operation_id."
        : `This is a replay: the operation had already committed under this operation_id, but its recorded outcome is `
          + `${replay.outcome === "none" ? "not available" : "incomplete"}`
          + `${Array.isArray(replay.omitted) && replay.omitted.length > 0 ? ` (missing: ${replay.omitted.join(", ")})` : ""}. `
          + "It ran exactly once. Re-read state to confirm what changed. Do not retry it under a new operation_id.";
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          { type: "text", text: JSON.stringify(resultKnown ? payload : null) },
          ...(observations && observations.length > 0
            ? [{ type: "text", text: JSON.stringify({ observations }) }]
            : []),
          ...(notice ? [{ type: "text", text: notice }] : [])
        ],
        structuredContent: {
          ...(resultKnown ? { result: payload } : {}),
          ...(observations ? { observations } : {}),
          ...(replay
            ? {
                replayed: true,
                replay_outcome: replay.outcome,
                ...(Array.isArray(replay.omitted) && replay.omitted.length > 0 ? { replay_omitted: replay.omitted } : {})
              }
            : {})
        },
        isError: false
      }
    });
  }

  /**
   * A failed tool call.
   *
   * `observations` is the same seat as on a successful reply (§M4.1), and it
   * matters MORE here: a verb that threw after emitting lines still commits
   * its transcript, the gateway suppresses the submitter's own committed
   * echo from `woo_wait` because the reply is supposed to carry them, and so
   * an error envelope without them loses those lines entirely — the actor
   * can never learn what its own failed action did. Absent for transport
   * failures and rejected commits, which ran no verb.
   *
   * `replay` marks a failure that is the RECORDED outcome of an earlier
   * committed turn rather than a fresh one. Without it a client sees an
   * error and cannot tell whether its retry ran again or replayed.
   */
  private mcpToolError(
    id: number | string,
    detail: unknown,
    observations?: unknown[],
    replay?: { replayed: true; outcome: string; omitted?: unknown[] }
  ): Response {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          { type: "text", text: JSON.stringify(detail) },
          ...(observations && observations.length > 0
            ? [{ type: "text", text: JSON.stringify({ observations }) }]
            : [])
        ],
        structuredContent: {
          error: detail,
          ...(observations ? { observations } : {}),
          ...(replay
            ? {
                replayed: true,
                replay_outcome: replay.outcome,
                ...(Array.isArray(replay.omitted) && replay.omitted.length > 0 ? { replay_omitted: replay.omitted } : {})
              }
            : {})
        },
        isError: true
      }
    });
  }

  /** woo_wait: drain immediately when buffered, else park up to
   * `timeoutMs` for the next fanout enqueue. One waiter list per
   * session; every parked waiter wakes on the next delivery. Each wake drains
   * at most the caller's limit and leaves the remainder queued. Concurrent
   * waiters cannot duplicate a row because splice claims each prefix once.
   *
   * Every reply carries `gap` (M5.1). Delivery stays at-most-once and
   * entirely in memory; `gap` only tells a polling agent whether this
   * gateway can still PROVE continuity since its last drain. A pending gap
   * short-circuits the park so the agent learns to re-orient immediately
   * instead of after a full long-poll. */
  private async mcpWait(
    session: string,
    actor: string,
    timeoutMs: number,
    limit: number,
    /** An `mcpRequestKey` value — the class-discriminated JSON-RPC id. */
    requestKey: string
  ): Promise<{ observations: unknown[]; gap: boolean } | { refused: Record<string, unknown> }> {
    const queue = this.mcpQueues.get(session);
    // No live state at all: nothing to drain and nothing to vouch for.
    if (!queue) return { observations: [], gap: true };
    const take = (): { observations: unknown[]; gap: boolean } => {
      const gap = queue.gapPending;
      queue.gapPending = false;
      // Re-baseline the continuity proof at the exact moment the client is
      // told what it has. Recorded on empty drains too: "you are caught up to
      // here" is the statement a later reconstruction needs, and it is what
      // makes an idle agent's next poll gap-free instead of perpetually
      // suspicious.
      this.recordMcpDrainWatermark(session, actor);
      return { observations: queue.buffer.splice(0, limit), gap };
    };
    if (queue.gapPending || queue.buffer.length > 0) return take();
    if (timeoutMs === 0) return take();
    // Bounded parking. Each parked call holds a closure and a live timer for
    // up to 25s, so an unbounded set is a resource-exhaustion vector on an
    // authenticated-but-public surface. One outstanding long-poll is the
    // well-behaved shape; the cap leaves room for a retry or two in flight
    // and refuses beyond that with a code that names the condition.
    if (queue.waiters.length >= MCP_MAX_SESSION_WAITS) {
      // Refused as a TOOL result, not a thrown taxonomy error: a throw here
      // would escape the woo_wait branch as an HTTP failure instead of the
      // MCP envelope a client can read.
      return {
        refused: {
          code: "E_WAIT_LIMIT",
          message: "too many concurrent woo_wait calls for this session",
          detail: {
            reason: "wait_concurrency",
            outstanding: queue.waiters.length,
            limit: MCP_MAX_SESSION_WAITS,
            remediation:
              "keep at most one woo_wait in flight per session; await it, or cancel it with "
              + "notifications/cancelled naming its request id"
          }
        }
      };
    }
    return await new Promise<{ observations: unknown[]; gap: boolean }>((resolve) => {
      const release = (): void => {
        clearTimeout(timer);
        const index = queue.waiters.findIndex((entry) => entry.wake === wake);
        if (index >= 0) queue.waiters.splice(index, 1);
      };
      const timer = setTimeout(() => {
        release();
        resolve(take());
      }, timeoutMs);
      const wake = (cancelled: boolean): void => {
        release();
        // A CANCELLED wait must not drain: the client is no longer reading
        // this response, and `take()` would consume buffered rows into a
        // reply nobody sees — at-most-once delivery turning into none.
        resolve(cancelled ? { observations: [], gap: false } : take());
      };
      queue.waiters.push({ requestKey, wake });
    });
  }

  /**
   * MCP `notifications/cancelled`: release the parked request it names.
   *
   * Ignoring cancellation left a client with no way to reclaim a parked slot
   * short of waiting out its timeout, which — with a bounded waiter set —
   * would turn a client's own abandoned polls into a self-inflicted refusal.
   * Unknown ids are silently fine: the request may have completed already,
   * and a cancellation is advisory by construction.
   *
   * `requestKey` is an `mcpRequestKey` value, not a raw id — the numeric and
   * string forms of the same digits are different requests.
   */
  private mcpCancelWait(session: string, requestKey: string): void {
    const queue = this.mcpQueues.get(session);
    if (!queue) return;
    const index = queue.waiters.findIndex((entry) => entry.requestKey === requestKey);
    if (index < 0) return;
    queue.waiters[index].wake(true);
  }

  /** Fanout-side feed (called after the same server-side submitter echo
   * dedupe the sockets get). Returns whether an MCP carrier accepted the
   * observations so no-socket telemetry does not mislabel MCP-only delivery.
   * Bounded buffer: overflow drops oldest — at-most-once live delivery. */
  private mcpEnqueue(session: string, observations: unknown[]): boolean {
    const queue = this.mcpQueues.get(session);
    if (!queue || observations.length === 0) return false;
    queue.buffer.push(...observations);
    if (queue.buffer.length > MCP_QUEUE_CAP) {
      // Overflow silently discarded undelivered rows. Record the loss so the
      // next drain can say so (M5.1) — the client cannot otherwise tell an
      // empty room from a dropped conversation.
      queue.buffer.splice(0, queue.buffer.length - MCP_QUEUE_CAP);
      queue.gapPending = true;
    }
    const waiters = queue.waiters.splice(0, queue.waiters.length);
    for (const waiter of waiters) waiter.wake(false);
    return true;
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
      // Observations: this request found a durable session with no live queue
      // behind it, so anything fanned out in between was dropped on the floor
      // — UNLESS this gateway can still prove nothing was fanned out. On
      // Cloudflare an idle gateway shard is evicted in ~10s, far inside a
      // turn-based agent's think time, so an unconditional gap here fired on
      // essentially every poll and taught agents to ignore the marker. The
      // durable drain watermark turns "I lost my queue" into the question
      // that actually matters, "did anything happen while it was gone?".
      // An `initialize` installs state explicitly (notifyOnRecover=false) and
      // therefore starts gap-free without consulting a watermark at all.
      created.gapPending = !this.mcpContinuityProven(session, actor);
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
    // Cancelled, not drained: the buffer above is already cleared, and a
    // disposed session must not record a drain watermark it will never use.
    const waiters = state.waiters.splice(0, state.waiters.length);
    for (const waiter of waiters) waiter.wake(true);
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
        // An anchored agent's cells live in its AUTHORITY ROOT's cluster, so a
        // fanout from that cluster (e.g. a demote committed in cluster:<human>)
        // affects its session even though `body.scope !== cluster:<agent>`. Match
        // the session actor's home cluster derived from view lineage (the anchor
        // walk), which reduces to `cluster:<actor>` for an unanchored root. Falls
        // back safely: an actor whose lineage this shard has not warmed classifies
        // to a non-cluster scope and simply does not match.
        if (body.scope === this.ownerScopeFor(state.actor)) candidates.add(session);
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

  /**
   * Resolve a paged discovery request against structural MCP context. The
   * scope vocabulary changes presentation only; it never grants reachability.
   *
   * NAME CANONICALISATION (mcp.md M2.3). The descriptor set — **final tool
   * names included** — is computed ONCE over the session's complete
   * structural context, by the same producer `tools/list` and dynamic-name
   * invocation use. Scope, `query`, and paging are pure projections of that
   * one set.
   *
   * This ordering is load-bearing, not tidiness. Tool names are sanitized
   * (`mcpSanitizeId` collapses every character outside `[A-Za-z0-9_]` to
   * `_`), so distinct ids can share a base name — `a-b` and `a_b` both
   * render `a_b`. Collisions are broken by a `_2`, `_3`… suffix assigned in
   * listing order. Generating names over a FILTERED subset therefore handed
   * out the *unsuffixed* name for whichever colliding object the filter
   * happened to keep, while invocation — which always regenerates over the
   * full context — bound that same name to the other object. An agent that
   * called exactly what discovery advertised reached a different object.
   *
   * The scope selection is now applied to canonical descriptors, which also
   * closes a second disagreement in the same place: `scope:"space"` used to
   * synthesize command-shaped drafts for a target and its contents even when
   * those objects were not in structural context, advertising descriptors
   * that neither dynamic-name invocation nor `woo_call` would accept.
   */
  private mcpToolPage(actor: string, session: string, args: Record<string, unknown>): NetMcpToolPage {
    const scope = mcpToolScope(args.scope);
    const activeScope = this.mcpActiveScope(actor, session);
    const object = typeof args.object === "string" && args.object ? args.object : null;
    const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
    const limit = mcpLimit(args.limit, MCP_DISCOVERY_DEFAULT_PAGE, MCP_DISCOVERY_MAX_PAGE);
    const cursor = mcpCursor(args.cursor);
    const context = this.mcpContextObjects(actor, session);
    const canonical = this.mcpToolsForObjects(actor, context, this.mcpActiveCommandContext(actor, session));
    const selected = this.mcpScopeSelection(scope, actor, activeScope, object, context);

    const normalized = query?.toLowerCase() ?? "";
    const all = canonical.filter((tool) =>
      selected.has(tool.object) && (
        !normalized || tool.name.toLowerCase().includes(normalized) ||
        tool.object.toLowerCase().includes(normalized) ||
        tool.verb.toLowerCase().includes(normalized) ||
        tool.description.toLowerCase().includes(normalized) ||
        tool.aliases.some((alias) => alias.toLowerCase().includes(normalized))
      )
    );
    const tools = all.slice(cursor, cursor + limit);
    const next = cursor + tools.length;
    return {
      scope,
      activeScope,
      object,
      query,
      limit,
      cursor: args.cursor === undefined ? null : String(cursor),
      nextCursor: next < all.length ? String(next) : null,
      total: all.length,
      tools,
      // Handed back so the caller can re-baseline the tools/list digest from
      // the set it just computed instead of computing the whole listing twice.
      canonical,
      context
    };
  }

  /** Which contextual objects a presentation scope selects. Selection is by
   * object id only — it filters the canonical descriptor set and can never
   * add an object the session does not structurally reach. */
  private mcpScopeSelection(
    scope: NetMcpToolScope,
    actor: string,
    activeScope: string | null,
    object: string | null,
    context: Set<string>
  ): Set<string> {
    if (scope === "active") return context;
    const out = new Set<string>();
    if (scope === "object") {
      if (object && context.has(object)) out.add(object);
      return out;
    }
    // `here` is the active space; `space` names one contextual space (the
    // active one by default). Both select that space plus its direct
    // contents, intersected with structural context by the caller's filter.
    const target = scope === "here" ? activeScope : (object ?? activeScope);
    if (!target || !context.has(target)) return out;
    out.add(target);
    for (const id of this.mcpContentsContext(target, actor)) out.add(id);
    return out;
  }

  /**
   * `woo_call`'s target resolution — the wide contract `help tools` has
   * always promised ("calls any verb you may reach, and still works when
   * your cached tool list is stale").
   *
   * It is deliberately wider than the dynamic tool LISTING. The listing is a
   * curated advertisement gated by `tool_exposed`; woo_call is the escape
   * hatch, and gating it on an advertising flag made an author's freshly
   * installed verb on an object in their own inventory uncallable until they
   * discovered `set_verb_info {tool_exposed:true}` — with a refusal
   * ("tool is not available in this session context") that named neither the
   * flag nor any other remediation. The gates that remain are the two that
   * mean something: structural reachability (M3) and verb existence, plus
   * the generic execute prefilter. Every world-level authority check —
   * E_PERM, the programmer/wizard flags, verb-body guards — still runs
   * unchanged inside the authoritative turn.
   *
   * Refusals name ONE condition each, because they have different
   * remediations: move/take vs. install the verb vs. get promoted.
   */
  private mcpResolveCall(
    actor: string,
    session: string,
    object: string,
    verb: string
  ): { tool: NetMcpToolDraft } | { error: { code: string; message: string; detail?: unknown } } {
    const context = this.mcpContextObjects(actor, session);
    if (!context.has(object)) {
      const active = this.mcpActiveScope(actor, session);
      return {
        error: {
          code: "E_PERM",
          message:
            `${object} is not reachable from this session. Reachable objects are you (${actor}), ` +
            `your space${active ? ` (${active})` : " — you are not in one"}, that space's contents, and your inventory.`,
          detail: {
            reason: "target_not_reachable",
            target: object,
            actor,
            active_scope: active,
            // The remediation, not a restatement of the rule.
            remediation: active
              ? `move to the object's space (a movement verb, or ${active}:enter <space>), or take it into your inventory`
              : "you are not in a space; enter one first (for example with your home verb)"
          }
        }
      };
    }
    const drafts = this.mcpObjectToolDrafts(actor, object, this.mcpActiveCommandContext(actor, session).has(object));
    const match = mcpMatchVerb(drafts, verb);
    if ("miss" in match) {
      // Same shape the engine raises for a missing verb (world.ts): a client
      // that already special-cases E_VERBNF keeps working.
      return {
        error: {
          code: "E_VERBNF",
          message: `verb not found: ${object}:${verb}`,
          detail: {
            obj: object,
            name: verb,
            reason: "verb_not_defined",
            remediation: `${object} is reachable but defines no ${verb} on its class chain; list its verbs, or install one`
          }
        }
      };
    }
    if ("ambiguous" in match) {
      // Several verbs on one definer answer to this name and the view cannot
      // order them, so the gateway cannot know which one the world would run.
      // Refuse: running the wrong verb is worse than declining to guess.
      return {
        error: {
          code: "E_MISSING_STATE",
          message: `${object}:${verb} matches several verbs whose definition order this gateway cannot determine`,
          detail: {
            reason: "verb_order_unavailable",
            obj: object,
            name: verb,
            candidates: match.ambiguous.map((draft) => draft.verb).sort(),
            remediation: "name one of the candidate verbs exactly instead of an alias"
          }
        }
      };
    }
    const tool = match.tool;
    if (!tool.bytecode) {
      return {
        error: {
          code: "E_PERM",
          message: `${object}:${verb} is a native verb and has no portable Net execution body`,
          detail: { reason: "native_verb", obj: object, name: verb }
        }
      };
    }
    if (!tool.executable) {
      return {
        error: {
          code: "E_PERM",
          message: `${object}:${verb} is not executable by you: its perms are "${tool.perms || "(none)"}" and you do not own it`,
          detail: { reason: "verb_not_executable", obj: object, name: verb, perms: tool.perms, remediation: "the verb owner must add the x permission" }
        }
      };
    }
    if (tool.route === "direct" && !tool.directCallable) {
      // The ingress gate (core.md C12.2) refuses this downstream too; naming
      // it here keeps the vocabulary uniform across woo_call's refusals.
      return {
        error: {
          code: "E_DIRECT_DENIED",
          message: `verb ${verb} is not externally direct-callable`,
          detail: { target: object, verb, reason: "not_direct_callable", remediation: "the verb needs the d permission to be invoked by an outside client" }
        }
      };
    }
    return { tool };
  }

  /** The exact dynamic set advertised by standard tools/list and accepted by
   * dynamic-name calls. woo_call resolves through the same draft producer
   * without the advertising gate — see mcpResolveCall. */
  private mcpContextTools(actor: string, session: string): NetMcpDynamicTool[] {
    return this.mcpToolsForObjects(
      actor,
      this.mcpContextObjects(actor, session),
      this.mcpActiveCommandContext(actor, session)
    );
  }

  /** The advertised name for one (object, verb) pair in THIS session's
   * canonical listing, or null when the pair is not advertised. Prose that
   * names a tool must read the canonical assignment; re-deriving a name by
   * sanitizing the id ignores collision suffixes and can therefore name a
   * different object's tool (M2.3). */
  private mcpAdvertisedName(actor: string, session: string, object: string, verb: string): string | null {
    return this.mcpContextTools(actor, session)
      .find((tool) => tool.object === object && tool.verb === verb)?.name ?? null;
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

  /**
   * The session's active space, or null when it has none.
   *
   * `$nowhere` is the substrate's placeless sentinel — the absence of a
   * location, spelled as an object — so it must answer null here, exactly
   * like a missing cell. Treating any non-empty string as a space made an
   * unplaced actor "in" $nowhere: `$here` resolved to it (instead of the
   * documented no-active-scope refusal), and $nowhere's own verbs were
   * projected as tools, which is why the walkthrough saw an unplaced actor
   * offered `nowhere__look` and `nowhere__set_description`. Freshly
   * provisioned agents (AP11) are placeless, so this is the first state a new
   * agent is in, not an edge case.
   */
  private mcpActiveScope(actor: string, session: string): string | null {
    const view = this.ensureView();
    const row = view.get(sessionCellKey(session))?.value as { activeScope?: unknown; active_scope?: unknown } | undefined;
    const scoped = typeof row?.activeScope === "string" ? row.activeScope : typeof row?.active_scope === "string" ? row.active_scope : null;
    if (scoped) return mcpPlacedScope(scoped);
    const live = view.get(cellKey("object_live", actor))?.value as { location?: unknown } | undefined;
    return typeof live?.location === "string" ? mcpPlacedScope(live.location) : null;
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
    // The actor's own object sorts ahead of the alphabetical remainder. A
    // client that reads only the first tools/list page must still see the
    // actor's own verbs — its "suit" — whatever its id happens to be. Plain
    // localeCompare stranded any actor whose id sorted past the page cap
    // behind whatever objects happened to share the space.
    const byObject = (a: string, b: string) =>
      (a === actor ? 0 : 1) - (b === actor ? 0 : 1) || a.localeCompare(b);
    const drafts: NetMcpToolDraft[] = [];
    for (const object of [...objects].sort(byObject)) {
      // The draft producer now yields every dispatchable page and marks the
      // gates; LISTING applies them. woo_call reads the same drafts without
      // the `exposed` gate (M2.1), so the two layers still share one resolver.
      for (const draft of this.mcpObjectToolDrafts(actor, object, commandObjects.has(object))) {
        if (draft.bytecode && draft.exposed && draft.executable) drafts.push(draft);
      }
    }
    drafts.sort((a, b) => byObject(a.object, b.object) || a.verb.localeCompare(b.verb));
    const used = new Set<string>();
    // Presentation — schema derivation and the doc-comment scan — happens
    // here, AFTER the listing gates. Producing a draft for every dispatchable
    // page is what lets woo_call reach unadvertised verbs; doing the
    // presentation work for them too would have made every tools/list pay for
    // pages nobody is going to see.
    return drafts.map((draft) => {
      // Sanitization is LOSSY — every character outside `[A-Za-z0-9_]`
      // becomes `_`, so `a-b` and `a_b` share the base `a_b` — and the
      // suffix that separates them is assigned in listing order. The
      // assignment is therefore only meaningful relative to the set it was
      // computed over, which is why every caller MUST pass the session's
      // complete structural context (mcp.md M2.3): `tools/list`, the
      // dynamic-name invocation resolver, the list digest, and
      // `woo_list_reachable_tools` (which then projects a page out of the
      // canonical set) all do. Naming a filtered subset would advertise a
      // name that invocation binds to a different object.
      const base = `${mcpSanitizeId(draft.object)}__${mcpSanitizeId(draft.verb)}`;
      let name = base;
      let suffix = 2;
      while (used.has(name)) name = `${base}_${suffix++}`;
      used.add(name);
      const input = mcpInputSchema(draft.argSpec);
      const paragraph = mcpFirstParagraph(draft.source);
      const callForm = `${draft.object}:${draft.verb}(${input.args.join(", ")})`;
      return {
        ...draft,
        name,
        inputSchema: input.schema,
        argNames: input.args,
        description: paragraph ? `${paragraph}\n\nCall: ${callForm}` : `Call: ${callForm}`
      };
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
        // SLOT ORDER, not alphabetical. Drafts are the resolution order (see
        // mcpMatchVerb), and the world dispatcher walks a definer's verbs in
        // definition order — `obj.verbs` is the slot array. Sorting by name
        // here made two same-definer verbs with overlapping alias patterns
        // resolve to whichever name sorted first, which is not the verb the
        // world would have run. Any presentation ordering the LISTING wants is
        // applied separately, downstream, in mcpToolsForObjects.
        //
        // The name is a deterministic tiebreak only for pages whose slot the
        // view does not carry; ambiguity that actually changes an answer is
        // refused rather than guessed (mcpMatchVerb).
        const pages = view.cellsForObject(current)
          .filter((cell) => cell.kind === "verb_bytecode" && typeof cell.name === "string")
          .sort((a, b) => {
            const left = mcpVerbSlot(a.value);
            const right = mcpVerbSlot(b.value);
            if (left !== right) {
              return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
            }
            return String(a.name).localeCompare(String(b.name));
          });
        for (const cell of pages) {
          const verb = cell.name as string;
          if (seenVerbs.has(verb)) continue;
          seenVerbs.add(verb); // an override hides every inherited page, exposed or not
          const page = cell.value as Record<string, unknown>;
          const argSpec = mcpRecord(page.arg_spec);
          const command = mcpRecord(argSpec.command);
          // The catalog's command contract is the one routing declaration
          // shared by shell and MCP clients. Absence stays fail-safe:
          // mutation tools commonly omit command metadata and must continue
          // through the sequencer.
          const route = command.persistence === "live" ? "direct" : "sequenced";
          const commandShaped = Object.keys(command).length > 0;
          const perms = typeof page.perms === "string" ? page.perms : "";
          const owner = typeof page.owner === "string" ? page.owner : "";
          const aliases = Array.isArray(page.aliases) ? page.aliases.filter((value): value is string => typeof value === "string") : [];
          out.push({
            object,
            // The class (or feature ancestor) that actually holds this page.
            // Verb-name resolution is per-definer (see mcpMatchVerb), so the
            // draft has to remember where it came from.
            definer: current,
            // Definition order within that definer. `null` when the view's
            // page does not carry one — see mcpMatchVerb's fail-closed rule.
            slot: mcpVerbSlot(cell.value),
            verb,
            route,
            aliases,
            // Raw inputs to presentation. Schema derivation and the
            // doc-comment scan are deferred to mcpToolsForObjects so an
            // unadvertised page costs one object, not one render.
            source: typeof page.source === "string" ? page.source : "",
            argSpec,
            // Only bytecode pages have a portable Net execution body (M2.2).
            // A native page still shadows its inherited namesakes, so it is
            // carried as a draft: that is what lets woo_call answer "native,
            // no Net body" instead of the wrong "verb not found".
            bytecode: page.kind === "bytecode",
            perms,
            // LISTING gate. `tool_exposed` decides whether a verb is
            // advertised; since the woo_call widening it decides nothing
            // else (M2.1).
            exposed: page.tool_exposed === true || (allowCommandShaped && commandShaped),
            // Generic execute-permission prefilter. The authoritative turn
            // re-checks; this only keeps unusable descriptors out of the
            // listing and produces an early, precise refusal for woo_call.
            executable: wizard || owner === actor || perms.includes("x"),
            // Ingress flag consumed by the direct route (core.md C12.2).
            directCallable: page.direct_callable === true
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
    try {
      const identity = await this.catalogIdentity();
      const boundActor = await this.authorizedActorForSessionBearer(session, identity.map);
      if (boundActor !== actor) {
        throw new ClientAuthError("ticket actor does not match session", {
          reason: "actor_mismatch"
        });
      }
    } catch (error) {
      return json({
        error: {
          code: "E_NOSESSION",
          message: error instanceof Error ? error.message : String(error)
        }
      }, 401);
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
        const boundActor = await this.authorizedActorForSessionBearer(att.session, identity.map);
        if (boundActor !== att.actor) {
          throw new ClientAuthError("socket actor does not match session", {
            reason: "actor_mismatch"
          });
        }
        const response = await this.clientTurn(att.actor, { ...frame, session: att.session }, identity.epoch);
        const payload = (await response.json()) as Record<string, unknown>;
        send({ type: "turn_result", ...(id !== undefined ? { id } : {}), status: response.status, ...payload });
      } catch (err) {
        const auth = err instanceof ClientAuthError ? err : null;
        send({
          type: "turn_result",
          ...(id !== undefined ? { id } : {}),
          status: auth?.status ?? 500,
          error: {
            code: auth?.code ?? (isNetError(err) ? err.code : "E_INTERNAL"),
            message: auth?.message ?? String(err),
            ...(auth ? { detail: auth.detail } : {})
          }
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
    this.pushScopedObservations(body, false);
  }

  /** Direct observations have no authority sequence and never touch the
   * gateway cache/high-water. They share only the local presence lookup and
   * socket/MCP carriers with committed fanout. */
  private pushLiveObservations(body: LiveFanoutBody): void {
    this.pushScopedObservations(body, true);
  }

  private pushScopedObservations(body: FanoutBody | LiveFanoutBody, live: boolean): void {
    // No WS surface (structural fakes / MCP-only runtimes) still feeds
    // the MCP wait queues — delivery has two carriers, one audience.
    const getSockets = this.state.getWebSockets?.bind(this.state);
    if (!Array.isArray(body.observations) || body.observations.length === 0) return;
    const liveBody = live ? body as LiveFanoutBody : null;
    // A relation mirror describes who is present, not who has a carrier on
    // THIS gateway. HTTP-only sessions receive their own observations on the
    // turn reply and cannot consume peer fanout. Snapshot hibernating sockets
    // once and skip the scope-indexed audience scan entirely when neither
    // transport exists; a 512-member room with zero sockets must remain O(1)
    // per inbound fanout on each gateway shard.
    const sockets = getSockets ? getSockets() : [];
    if (sockets.length === 0 && this.mcpQueues.size === 0) {
      this.metric({
        kind: "net_push_no_carriers",
        scope: body.scope,
        route: live ? "live" : "committed",
        observations: body.observations.length
      });
      return;
    }
    const attachments = sockets
      .map((socket) => ({ socket, attachment: this.socketAttachment(socket) }))
      .filter((entry): entry is { socket: WebSocket; attachment: GatewaySocketAttachment } => entry.attachment !== null);
    const socketsBySession = new Map<string, WebSocket[]>();
    for (const { socket, attachment } of attachments) {
      const tagged = socketsBySession.get(attachment.session) ?? [];
      tagged.push(socket);
      socketsBySession.set(attachment.session, tagged);
    }
    // Phase 2: intersect the scope-indexed mirror with THIS shard's bounded
    // carrier sessions. Presence is global authority state; peer observation
    // delivery is local transport state. Scanning every room occupant because
    // one local socket exists recreates O(V*N) fanout across gateway shards.
    // Chunk the IN set below SQLite's conservative bind ceiling; the composite
    // (relation, owner_scope, member) index makes cost O(local carriers).
    const carrierSessions = [...new Set([...socketsBySession.keys(), ...this.mcpQueues.keys()])].sort();
    const rows: Array<{ member: string; body: string | null }> = [];
    for (let offset = 0; offset < carrierSessions.length; offset += GATEWAY_CARRIER_QUERY_CHUNK) {
      const chunk = carrierSessions.slice(offset, offset + GATEWAY_CARRIER_QUERY_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      rows.push(...sqlRows<{ member: string; body: string | null }>(
        this.state.storage.sql.exec(
          `SELECT member, body FROM net_gateway_relation WHERE relation = ? AND owner_scope = ? AND member IN (${placeholders})`,
          SESSION_PRESENCE_RELATION,
          body.scope,
          ...chunk
        )
      ));
    }
    // Load-gate evidence (CO10): rows scanned track local in-scope carriers,
    // flat as either room population or off-scope sessions grow.
    this.metric({
      kind: "net_presence_scan",
      scope: body.scope,
      presence_scan_rows: rows.length,
      carrier_sessions: carrierSessions.length
    });
    if (rows.length === 0) return;
    // Session -> actor for the directed-observation filter below: the
    // presence row body carries the session's actor (CO13 applier).
    const actorOf = new Map<string, string | null>();
    for (const row of rows) {
      const parsed = row.body ? (JSON.parse(row.body) as { actor?: string }) : null;
      actorOf.set(row.member, typeof parsed?.actor === "string" ? parsed.actor : null);
    }
    // Compile compact negative audiences once per fanout. Applying an array
    // scan for every (carrier session × observation) would turn a catalog's
    // exclusion list into an avoidable O(N*E) delivery cost.
    const presenceExclusions = (liveBody?.observationAudienceExclusions ?? []).map(
      (items) => new Set(Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [])
    );
    // NC8a fanout-cost evidence: audience size and frames actually sent —
    // the "fanout cost as audience grows" dashboard series.
    let deliveredMembers = 0;
    let framesSent = 0;
    let mcpSessions = 0;
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
      const actor = actorOf.get(row.member) ?? null;
      const visible = (body.observations as Array<Record<string, unknown>>).filter((obs, index) => {
        if (live) {
          const mode = liveBody?.observationAudienceModes?.[index];
          if (mode === "presence") {
            // The indexed query already selected sessions present in this
            // scope. Re-resolve the audience on every shard: the planning
            // gateway's enumerated room snapshot is not globally complete.
            if (actor !== null && presenceExclusions[index]?.has(actor)) return false;
            return !(
              (obs.type === "entered" || obs.type === "left" || obs.type === "taken" || obs.type === "dropped")
              && typeof obs.actor === "string"
              && obs.actor === actor
            );
          }
          // Explicit recipients retain both forms. A session match is most
          // precise; actor fallback is safe because rows are already limited
          // to this scope, so another tab for that actor elsewhere is absent.
          const sessionAudience = liveBody?.observationSessionAudiences?.[index] ?? liveBody?.audienceSessions;
          const actorAudience = liveBody?.observationAudiences?.[index] ?? liveBody?.audienceActors;
          if (mode === "explicit") {
            if (Array.isArray(sessionAudience) && sessionAudience.includes(row.member)) return true;
            if (Array.isArray(actorAudience)) return actor !== null && actorAudience.includes(actor);
            return Array.isArray(sessionAudience) ? false : observationReachesActor(obs as unknown as Observation, actor);
          }
          // Compatibility for older live carriers that predate the mode
          // vector: preserve their session-first filtering contract.
          if (Array.isArray(sessionAudience)) return sessionAudience.includes(row.member);
          if (Array.isArray(actorAudience)) return actor !== null && actorAudience.includes(actor);
        }
        // Committed fanout (and the rolling fallback for older live carriers)
        // ships no audience vector — every shard re-resolves delivery from its
        // own presence mirror. Apply the audience rules that live inside the
        // observation itself: directed `told`/`text` reach only their named
        // recipient, self-addressed `looked`/`who` only their `to`, everything
        // else broadcasts to the sessions present in this scope. See
        // observationReachesActor (core/types.ts) and events.md §12.7.
        return observationReachesActor(obs as unknown as Observation, actor);
      });
      if (visible.length === 0) continue;
      deliveredMembers += 1;
      // MCP wait queues ride the SAME audience + submitter dedupe as the
      // sockets (client-shell phase i).
      if (this.mcpEnqueue(row.member, visible)) mcpSessions += 1;
      const frame = JSON.stringify({
        type: live ? "live_observations" : "observations",
        scope: body.scope,
        ...(!live && "seq" in body ? { seq: body.seq } : {}),
        // SECURITY: never expose submitter_turn_id here. It is the scope's
        // idempotent-reply replay credential. echo_id is a one-way digest.
        ...(body.echo_id !== undefined ? { echo_id: body.echo_id } : {}),
        observations: visible
      });
      for (const ws of socketsBySession.get(row.member) ?? []) {
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
      ...(!live && "seq" in body ? { seq: body.seq } : {}),
      route: live ? "live" : "committed",
      audience: rows.length,
      delivered_members: deliveredMembers,
      frames: framesSent,
      mcp_sessions: mcpSessions,
      observations: body.observations.length
    });
    if (getSockets && deliveredMembers > 0 && framesSent === 0 && mcpSessions === 0) {
      // An audience with no live carrier is the actionable failure shape,
      // but scanning the whole shard registry on every healthy push would
      // violate the occupant-bounded hot path. Pay this diagnostic only on
      // the anomaly and report counts, never bearer session ids.
      const attachedSessions = new Set(attachments.map(({ attachment }) => attachment.session));
      const liveSessionAudience = new Set([
        ...(liveBody?.audienceSessions ?? []),
        ...(liveBody?.observationSessionAudiences ?? []).flat()
      ]);
      const liveActorAudience = new Set([
        ...(liveBody?.audienceActors ?? []),
        ...(liveBody?.observationAudiences ?? []).flat()
      ]);
      this.metric({
        kind: "net_push_socket_miss",
        scope: body.scope,
        route: live ? "live" : "committed",
        presence_rows: rows.length,
        delivered_members: deliveredMembers,
        sockets: sockets.length,
        attached_sessions: attachedSessions.size,
        presence_socket_matches: rows.filter((row) => attachedSessions.has(row.member)).length,
        live_session_audience: liveSessionAudience.size,
        live_actor_audience: liveActorAudience.size,
        attached_session_audience_matches: attachments.filter(({ attachment }) => liveSessionAudience.has(attachment.session)).length,
        attached_actor_audience_matches: attachments.filter(({ attachment }) => liveActorAudience.has(attachment.actor)).length
      });
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
    // Explicit override wins for fake harnesses and legacy one-shard
    // deployments whose DurableObjectId test label is not its route name.
    // Multi-shard deployments omit it and use the actual idFromName name.
    const self = this.selfDestination();
    if (!self || this.selfSubscribed.has(scope)) return;
    this.selfSubscribed.add(scope);
    this.ensureView();
    const deliveryResume = {
      baseline: this.deliverySeen.get(scope) ?? 0
    };
    this.deliveryResumes.set(scope, deliveryResume);
    try {
      const subscribed = await this.host.rpc(`scope:${scope}`, "/subscribe", { destination: self }) as {
        resume_delivery_seq?: unknown;
      };
      const resumeDeliverySeq = subscribed.resume_delivery_seq;
      if (Number.isSafeInteger(resumeDeliverySeq) && Number(resumeDeliverySeq) >= 0) {
        this.advanceDeliverySeen(scope, Number(resumeDeliverySeq));
      }
      this.finishDeliveryResume(
        scope,
        Number.isSafeInteger(resumeDeliverySeq) && Number(resumeDeliverySeq) >= 0
          ? Number(resumeDeliverySeq)
          : deliveryResume.baseline
      );
      if (scope === CATALOG_SCOPE) {
        await this.pull({ scope, destination: `scope:${scope}` });
      } else {
        await this.pullTargeted(scope, `scope:${scope}`, []);
      }
    } catch (err) {
      // The failed subscribe is already a named error. Without a successful
      // response there is no authoritative prefix against which an
      // interleaved delivery can be classified, so do not manufacture a
      // second integrity incident from that ambiguous window.
      this.deliveryResumes.delete(scope);
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
    return (cell?.value as { actor: string }).actor;
  }

  /** Keep the base session lookup synchronous: it is also the structural
   * session primitive used by rehydration tests and callers that do not need
   * network I/O. Transport authentication adds the key-revocation fence in
   * this explicit asynchronous layer. */
  private async authorizedActorForSessionBearer(session: string, legacyMap?: unknown): Promise<string> {
    const actor = this.actorForSessionBearer(session);
    this.assertActorNotRetired(actor);
    const value = this.ensureView().get(sessionCellKey(session))?.value as { apikeyId?: unknown } | undefined;
    if (typeof value?.apikeyId === "string" && value.apikeyId) {
      await this.assertSessionApiKeyActive(value.apikeyId, actor, legacyMap);
    }
    return actor;
  }

  /**
   * Retirement must reach LIVE credentials, not just new sessions.
   *
   * `assertActorEligible` runs at session MINT. Without this check both client
   * credential classes outlived `revoke_agent` indefinitely: a session bearer
   * presents a session id and never re-presents its key, and an apikey holder
   * pairs a long-lived key with an already-minted session id. Both were
   * verified to keep transacting after retirement — the apikey case committed
   * a wizard-only `set_quota` turn. That is precisely the wrong failure mode
   * for an operator-provisioned wizard: the actor is tombstoned and the
   * transport keeps serving it.
   *
   * Deliberately VIEW-ONLY and conservative:
   *
   *  - It reads the tombstone cell already in this gateway's derived view and
   *    never warms or fetches. This is a hot path on every session-bearer call;
   *    a cross-DO hop per request is not acceptable, and the revocation commits
   *    in the same authority cluster that hosts the session cell — a scope this
   *    gateway subscribed to when it minted the session — so the tombstone
   *    arrives by ordinary fanout.
   *  - Absence of the cell is NOT a refusal. A gateway that has never seen the
   *    actor's cluster cannot distinguish "not deactivated" from "not pulled",
   *    and failing closed there would break every cold-view session.
   *
   * Propagation is therefore eventual (fanout latency — seconds, not instant),
   * and the key check below remains the second, authoritative gate: it reads
   * the verifier from the owning authority and catches a revoked credential
   * even when the tombstone has not landed yet.
   */
  private assertActorNotRetired(actor: string): void {
    const cell = this.ensureView().get(cellKey("property_cell", actor, "deactivated_at"))?.value as
      | { value?: unknown }
      | undefined;
    if (cell && "value" in cell && cell.value != null) {
      throw new ClientAuthError(
        "identity deactivated",
        { reason: "identity_deactivated", actor },
        "E_PERM",
        403
      );
    }
  }

  /** A session minted from a long-lived key remains subordinate to that key.
   * Bearer-only transports retain only the public key id, so re-check the
   * exact current verifier record (or the carried legacy map) without ever
   * persisting or replaying the secret. */
  private async assertSessionApiKeyActive(id: string, actor: string, legacyMap?: unknown): Promise<void> {
    const routed = parseRoutedApiKeyId(id);
    let record: unknown;
    if (routed) {
      const scope = routedApiKeyScope(id);
      if (!scope || routed.actor !== actor) {
        throw new ClientAuthError("session source apikey is invalid", {
          reason: "session_apikey_mismatch"
        });
      }
      record = (await this.routedApiKeyAuthorityRecord(scope, actor, id)).record;
    } else {
      const map = legacyMap && typeof legacyMap === "object" && !Array.isArray(legacyMap)
        ? legacyMap as Record<string, unknown>
        : {};
      record = map[id];
    }
    const entry =
      record && typeof record === "object" && !Array.isArray(record)
        ? record as Record<string, unknown>
        : null;
    if (
      !entry ||
      entry.actor !== actor ||
      typeof entry.hash !== "string" ||
      typeof entry.salt !== "string" ||
      entry.revoked_at != null
    ) {
      throw new ClientAuthError("session source apikey not found or revoked", {
        reason: "session_apikey_revoked"
      });
    }
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
   * Read one exact mirrored relation row. Hot authorization paths must use
   * this indexed `(relation, owner, member)` lookup instead of enumerating a
   * room's whole relation family: room occupancy is unbounded in Big World.
   */
  private relationMember(
    relation: string,
    owner: string,
    member: string
  ): { member: string; member_scope?: string; body?: unknown } | undefined {
    const row = sqlRows<{ member: string; member_scope: string | null; body: string | null }>(
      this.state.storage.sql.exec(
        "SELECT member, member_scope, body FROM net_gateway_relation WHERE relation = ? AND owner = ? AND member = ? LIMIT 1",
        relation,
        owner,
        member
      )
    )[0];
    if (!row) return undefined;
    return {
      member: row.member,
      ...(row.member_scope !== null ? { member_scope: row.member_scope } : {}),
      ...(row.body !== null ? { body: JSON.parse(row.body) as unknown } : {})
    };
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
    const room = this.roomRosterRoom(request, view, classifier);
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

  /** Resolve the topology-owned room for one compact roster read without IO.
   *
   * Kept separate from roomRosterProjection so repair rounds can reuse the
   * same authoritative snapshot only while the actor/session still resolves to
   * that room. A concurrent move changes this answer and forces a fresh read. */
  private roomRosterRoom(
    request: TurnRequest,
    view: CellStore,
    classifier: ScopeClassifier
  ): string | null {
    const call = request.call;
    if (!this.callReadsRoomPresence(view, call)) return null;
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
    return room;
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
    ), { phase: "ordered_children" }) as { scope?: unknown; head?: unknown; container?: unknown; parent?: unknown; rows?: unknown; version?: unknown };
    // Full reply validation (Adv-a): a wrong-scope echo or a versionless
    // reply must be a FAILED fetch (retried on the bounded attempt loop),
    // never an answer the plan attests.
    if (response.scope !== scope || !validScopeHead(response.head) || response.container !== container || response.parent !== parent || !Array.isArray(response.rows)
      || typeof response.version !== "string" || response.version.length === 0) {
      throw new Error(`ordered-children authority returned a malformed projection for ${parent ?? "<root>"} at ${scope}`);
    }
    // The authority's content version of the ordering (P1.1): the plan attests
    // it so a concurrent same-parent insert makes the submit stale. The owning
    // scope rides along (R3) so cross-scope commits owner-attest the read.
    return { container, scope, parent, rows: response.rows as Record<string, unknown>[], version: response.version, authority_head: response.head };
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
    ), { phase: "ordered_neighbors" }) as { scope?: unknown; head?: unknown; container?: unknown; parent?: unknown; count?: unknown; index?: unknown; before?: unknown; after?: unknown; child_index?: unknown; version?: unknown };
    // Full reply validation (Adv-a): scope echo, a nonempty ordering version,
    // integral count/slot within range, rank fields consistent with the slot
    // (a slot with a live neighbour must carry its rank), and a sane
    // child_index. Anything else is a FAILED fetch — retried on the bounded
    // attempt loop — never an answer the plan computes a rank from.
    const count = response.count;
    const index = response.index;
    const malformed =
      response.scope !== scope
      || !validScopeHead(response.head)
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
      version: response.version as string,
      authority_head: response.head as ScopeHead
    };
  }

  /** Fetch ONE committed replay page from the space's owning authority
   * (sequenced-log.md SL4) — the log analogue of `fetchOrderedChildren`.
   * The SEMANTIC space id routes through the classifier to the authority
   * ADDRESS (`scopeOf(space)`); the page's entries keep their semantic
   * identity so the planning-world `replay` read is lane-identical. The
   * authority `version` (page content address) is what the plan attests;
   * a committed append inside the window then rejects the submit stale. */
  private async fetchReplayPage(
    request: TurnRequest,
    classifier: ScopeClassifier,
    structure: TurnStructure,
    query: ReplayPageQuery
  ): Promise<ReplayPageProjection> {
    const scope = classifier.scopeOf(query.space);
    const response = await structure.rpc(() => this.host.rpc(
      this.destinationFor(request, scope),
      "/replay-page",
      { space: query.space, from: query.from, limit: query.limit }
    ), { phase: "replay_page" }) as { scope?: unknown; head?: unknown; space?: unknown; from?: unknown; limit?: unknown; entries?: unknown; version?: unknown };
    // Full reply validation (Adv-a): a wrong-scope echo, a mutated query
    // echo, or a versionless reply is a FAILED fetch (retried on the
    // bounded attempt loop) — never a page the plan attests. Entry count
    // must respect the requested window, or the attested version would
    // describe a different query than the one the commit re-derives.
    if (response.scope !== scope || !validScopeHead(response.head)
      || response.space !== query.space || response.from !== query.from || response.limit !== query.limit
      || !validReplayLogPage(response.entries, query)
      || typeof response.version !== "string" || response.version.length === 0) {
      throw new Error(`replay-page authority returned a malformed page for ${query.space}@${query.from}+${query.limit} at ${scope}`);
    }
    const authorityEntries = response.entries;
    if (replayPageVersion(authorityEntries) !== response.version) {
      throw new Error(`replay-page authority returned a content/version mismatch for ${query.space}@${query.from}+${query.limit} at ${scope}`);
    }
    // Strip the redundant per-entry space key for the planning shape; the
    // attested `version` stays the authority's (computed over its own
    // stored rows), which is also what it re-derives at submit.
    const entries = authorityEntries.map(({ space: _space, ...entry }) => entry);
    return { space: query.space, from: query.from, limit: query.limit, scope, entries, version: response.version, authority_head: response.head };
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
    // `{arg: N}`: the object-valued positional argument itself is the
    // prefetch target. A verb that operates on an object passed by the
    // caller (promote/demote an agent, gift an item) names the arg here so
    // its authority cells — flags, features, owned-object lineage — are warm
    // before planning, rather than defaulting silently (a property read of an
    // unwarmed instance returns the class default, never an E_MISSING_STATE
    // the repair loop could act on). This is the arg-value analogue of the
    // `target`/`actor`/`scope` roots.
    if (typeof map.arg === "number" && Number.isInteger(map.arg) && map.arg >= 0) {
      const ref = call.args[map.arg];
      return typeof ref === "string" && ref.trim().length > 0 ? [ref.trim()] : [];
    }
    // `{ref: "<object>"}`: a fixed object the verb reaches that appears in
    // neither the call nor the actor's context. A verb whose body targets a
    // catalog's own seed instance (an editor room, a registry) cannot name it
    // through `target`/`actor`/`scope` or an argument, and without warming it
    // the instance is simply absent from the turn's world — its class chain
    // resolves, so `isa()` against it silently answers false rather than
    // raising anything the repair loop could act on. The literal lives in the
    // catalog manifest that owns the object; core stays catalog-agnostic and
    // only learns "warm the object this verb names".
    if (typeof map.ref === "string" && map.ref.trim().length > 0) return [map.ref.trim()];
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

  /** The first `limit` entries of an object's parent chain as this gateway's
   * view holds it. Used only by the AP11 probe, to let an operator SEE that the
   * id they named is (or is not) a human actor rather than infer it from a
   * refusal. Bounded and view-only: no warm, no cross-DO hop. */
  private netAncestry(object: string, limit: number): string[] {
    const view = this.ensureView();
    const chain: string[] = [];
    let current: string | null = object;
    const seen = new Set<string>();
    while (current && chain.length < limit && !seen.has(current)) {
      seen.add(current);
      const lineage = view.get(cellKey("object_lineage", current))?.value as { parent?: unknown } | undefined;
      current = typeof lineage?.parent === "string" ? lineage.parent : null;
      if (current) chain.push(current);
    }
    return chain;
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

  /** The scope pinned to an idempotency key, or null (fix 5c). An EXPIRED pin
   * is not a pin: its lease is the same boundary the authority prunes its
   * recorded reply on, so past it there is nothing left to route back to. */
  private pinnedScope(idempotencyKey: string): string | null {
    const rows = sqlRows<{ scope: string }>(
      this.state.storage.sql.exec(
        // A NULL lease is a legacy row, and legacy reads as LIVE: honouring a
        // route we can no longer date is the harmless direction (a pin
        // outliving its reply costs nothing), while treating it as expired
        // would silently drop exactly the routes this change exists to keep.
        // The constructor backfill retires them on the next boot.
        "SELECT scope FROM net_gateway_pin WHERE idempotency_key = ? AND (expires_at IS NULL OR expires_at > ?)",
        idempotencyKey,
        Date.now()
      )
    );
    return rows.length > 0 ? rows[0].scope : null;
  }

  /**
   * Persist the key → scope pin; first writer wins (fix 5c).
   *
   * Retention is by lease, never by eviction of a live guarantee — see
   * GATEWAY_PIN_LEASE_MS for why counting rows cannot establish the ordering
   * this rests on. On each admission:
   *
   * 1. expired rows go, whatever their class;
   * 2. TRANSIENT rows (gateway-minted keys) are trimmed to their own capacity,
   *    oldest first, so they can never crowd out a guarantee;
   * 3. a GUARANTEED admission at capacity is REFUSED — reported to the caller,
   *    which turns it into `E_RETRY_CAPACITY` before anything is submitted.
   *
   * Returns `"capacity"` for that refusal and `"pinned"` otherwise. The
   * refusal is a real cost of the design and is stated plainly in mcp.md
   * §M4.2: a client is told its retry guarantee cannot be issued right now,
   * which is strictly better than issuing one that silently does not hold.
   */
  private pinScope(idempotencyKey: string, scope: string, guaranteed: boolean): "pinned" | "capacity" {
    const now = Date.now();
    this.state.storage.sql.exec("DELETE FROM net_gateway_pin WHERE expires_at <= ?", now);
    const transient = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_pin WHERE guaranteed = 0")
    )[0];
    if (transient && Number(transient.n) > GATEWAY_TRANSIENT_PIN_CAPACITY) {
      this.state.storage.sql.exec(
        "DELETE FROM net_gateway_pin WHERE guaranteed = 0 AND rowid NOT IN " +
          "(SELECT rowid FROM net_gateway_pin WHERE guaranteed = 0 ORDER BY rowid DESC LIMIT ?)",
        GATEWAY_TRANSIENT_PIN_CAPACITY
      );
    }
    if (guaranteed) {
      const held = sqlRows<{ n: number }>(
        this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_pin WHERE guaranteed = 1")
      )[0];
      if (held && Number(held.n) >= GATEWAY_GUARANTEED_PIN_CAPACITY) {
        this.metric({ kind: "net_turn_pin_capacity_refusal", scope, held: Number(held.n) });
        return "capacity";
      }
    }
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_pin (idempotency_key, scope, expires_at, guaranteed) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(idempotency_key) DO NOTHING",
      idempotencyKey,
      scope,
      now + GATEWAY_PIN_LEASE_MS,
      guaranteed ? 1 : 0
    );
    return "pinned";
  }

  /** Scopes that carry at least one durable MCP drain watermark, loaded once
   * per isolate. Used to keep the live-fanout counter off shards that have no
   * continuity claim to protect. */
  private mcpWatermarkScopeSet(): Set<string> {
    if (this.mcpWatermarkScopesLoaded) return this.mcpWatermarkScopes;
    for (const row of sqlRows<{ scope: string }>(
      this.state.storage.sql.exec("SELECT DISTINCT scope FROM net_gateway_mcp_watermark")
    )) {
      this.mcpWatermarkScopes.add(row.scope);
    }
    this.mcpWatermarkScopesLoaded = true;
    return this.mcpWatermarkScopes;
  }

  /** M5.1: the SCOPE NAME whose delivery counters govern this session's
   * continuity — the `room:<id>` scope name, not the bare object id.
   *
   * `mcpActiveScope` answers in object ids; `deliverySeen`/`liveSeen` are
   * keyed by scope names, because that is what a fanout body carries. Getting
   * this mapping wrong does not fail loudly — it silently compares two
   * counters that are always zero and reports continuity for everything —
   * so both the recorder and the checker go through this one function.
   *
   * Returns null when the session is placeless or the anchor's lineage is not
   * resident (a cold gateway cannot classify it). Null means "cannot prove",
   * which degrades to the old conservative `gap:true`. */
  private mcpDeliveryScope(actor: string, session: string): string | null {
    const anchor = this.mcpActiveScope(actor, session);
    if (anchor === null) return null;
    try {
      return this.viewClassifier(this.ensureView()).scopeOf(anchor);
    } catch {
      return null;
    }
  }

  /** M5.1: count one applied LIVE fanout body for a scope, durably.
   *
   * Only scopes an MCP session has actually drained in are counted: the
   * counter exists solely to break a continuity claim, and a scope with no
   * watermark has no claim. That keeps the live delivery path free on shards
   * carrying only sockets (which have their own reconnect semantics) or no
   * pollers at all. */
  private advanceLiveSeen(scope: string): void {
    if (!this.mcpWatermarkScopeSet().has(scope)) return;
    const next = (this.liveSeen.get(scope) ?? 0) + 1;
    this.liveSeen.set(scope, next);
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_scope (scope, seen_seq, delivery_seen_seq, live_seq) VALUES (?, 0, 0, ?) "
      + "ON CONFLICT(scope) DO UPDATE SET live_seq = MAX(live_seq, excluded.live_seq)",
      scope,
      next
    );
  }

  /** M5.1: record where a drain left this session, so a later reconstruction
   * can prove nothing was dropped in between.
   *
   * Written on every reply that hands observations back to the client (and on
   * an empty one — an empty drain is just as much a "you are caught up to
   * here" statement). Bounded: only the most recent GATEWAY_WATERMARK_LIMIT
   * rows are kept, and a pruned row degrades to the old conservative
   * `gap:true`, never to a false continuity claim. */
  private recordMcpDrainWatermark(session: string, actor: string): void {
    const scope = this.mcpDeliveryScope(actor, session);
    if (scope === null) return; // placeless / unclassifiable: nothing to vouch for
    this.mcpWatermarkScopeSet().add(scope);
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_mcp_watermark (session, scope, delivery_seq, live_seq, ts) VALUES (?, ?, ?, ?, ?) "
      + "ON CONFLICT(session) DO UPDATE SET scope = excluded.scope, delivery_seq = excluded.delivery_seq, "
      + "live_seq = excluded.live_seq, ts = excluded.ts",
      session,
      scope,
      this.deliverySeen.get(scope) ?? 0,
      this.liveSeen.get(scope) ?? 0,
      this.host.now()
    );
    // A drain happens on every poll of every session, so the retention check
    // is amortized rather than run per write: the table can only grow by one
    // row per NEW session, so an occasional sweep keeps the same bound
    // without paying a COUNT scan on the hot polling path.
    this.mcpWatermarkWrites += 1;
    if (this.mcpWatermarkWrites % MCP_WATERMARK_SWEEP_INTERVAL !== 0) return;
    const count = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_mcp_watermark")
    )[0];
    if (count && Number(count.n) > GATEWAY_WATERMARK_LIMIT) {
      this.state.storage.sql.exec(
        "DELETE FROM net_gateway_mcp_watermark WHERE rowid NOT IN "
        + "(SELECT rowid FROM net_gateway_mcp_watermark ORDER BY ts DESC LIMIT ?)",
        GATEWAY_WATERMARK_LIMIT
      );
    }
  }

  /** M5.1: can this gateway prove the session missed nothing since its last
   * drain? True only when a watermark exists, still names the session's
   * current scope, and BOTH delivery counters for that scope are unchanged.
   *
   * Conservative in the safe direction: an advanced counter reports a gap
   * even when the fanout in question would not have reached this session
   * (a peer-directed `tell`, or the session's own echo). It is the honest
   * bound on what this gateway can know after losing its queue. */
  private mcpContinuityProven(session: string, actor: string): boolean {
    const row = sqlRows<{ scope: string; delivery_seq: number; live_seq: number }>(
      this.state.storage.sql.exec(
        "SELECT scope, delivery_seq, live_seq FROM net_gateway_mcp_watermark WHERE session = ?",
        session
      )
    )[0];
    if (row === undefined) return false;
    const scope = this.mcpDeliveryScope(actor, session);
    if (scope === null || scope !== row.scope) return false;
    return (this.deliverySeen.get(scope) ?? 0) === Number(row.delivery_seq)
      && (this.liveSeen.get(scope) ?? 0) === Number(row.live_seq);
  }

  /** Actor bound to a successfully closed session, if its bounded retry
   * receipt remains resident on this session-routed gateway. */
  private closedSessionActor(session: string): string | null {
    const rows = sqlRows<{ actor: string }>(
      this.state.storage.sql.exec(
        "SELECT actor FROM net_gateway_session_close_receipt WHERE session = ?",
        session
      )
    );
    return rows[0]?.actor ?? null;
  }

  /** Preserve semantic idempotency across the self-invalidating close edge.
   *
   * The session authority remains the only writer of session state. This row
   * merely remembers an accepted outcome on the deterministic gateway route,
   * just like a reply cache. Once pruned, an ancient replay returns the normal
   * missing-bearer refusal; no authority fact is reconstructed from it. */
  private recordSessionCloseReceipt(session: string, actor: string): void {
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_session_close_receipt (session, actor) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET actor = excluded.actor",
      session,
      actor
    );
    const count = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_session_close_receipt")
    )[0];
    if (count && Number(count.n) > GATEWAY_SESSION_CLOSE_RECEIPT_LIMIT) {
      this.state.storage.sql.exec(
        "DELETE FROM net_gateway_session_close_receipt WHERE rowid NOT IN (SELECT rowid FROM net_gateway_session_close_receipt ORDER BY rowid DESC LIMIT ?)",
        GATEWAY_SESSION_CLOSE_RECEIPT_LIMIT
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
    structure?: TurnStructure,
    reusable?: CommitSubmit["attestations"]
  ): Promise<CommitSubmit["attestations"]> {
    const byOwner = new Map<string, Set<string>>();
    const cellVersionsByOwner = new Map<string, Map<string, string>>();
    for (const read of planned.transcript.reads) {
      const key = netCellKeyFor(read.cell);
      if (key === null) continue; // contents reads are projection reads (CA4)
      // CO14: session cells classify by the calling actor (sessions.ts
      // classification rule — session ids carry no lineage; their
      // authority is the actor's cluster). A committing room may instead
      // prove the read from its owner-sequenced session_presence checkpoint.
      // Skip the live cluster attestation only when this gateway already
      // mirrors that exact checkpoint value; the room revalidates its current
      // row, so a stale/missing mirror can never authorize a turn.
      if (read.cell.kind === "session") {
        const value = read.value as { actor?: unknown; activeScope?: unknown } | undefined;
        const activeScope = typeof value?.activeScope === "string" ? value.activeScope : null;
        const projected = activeScope === null
          ? undefined
          : this.relationMember(SESSION_PRESENCE_RELATION, activeScope, read.cell.object);
        const projectedValue = (projected?.body as { session?: unknown } | undefined)?.session;
        if (
          activeScope !== null
          && targetScope === `room:${activeScope}`
          && projectedValue !== undefined
          && cellVersion(projectedValue) === String(read.version)
        ) {
          continue;
        }
      }
      const owner =
        read.cell.kind === "session"
          ? classifier.scopeOf(planned.transcript.call.actor)
          : classifier.scopeOf(read.cell.object);
      if (owner === targetScope) continue; // validated locally at the committing scope
      const keys = byOwner.get(owner) ?? new Set<string>();
      keys.add(key);
      byOwner.set(owner, keys);
      if (read.version !== undefined) {
        const versions = cellVersionsByOwner.get(owner) ?? new Map<string, string>();
        versions.set(key, String(read.version));
        cellVersionsByOwner.set(owner, versions);
      }
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
    // Foreign REPLAY-PAGE reads owner-attest the same way (SL4): the
    // /net/attest reply reports the owner's CURRENT page version per exact
    // query, so a committed append inside the window between plan and
    // attest makes the committing scope reject the stale read.
    const replaysByOwner = new Map<string, Map<string, ReplayPageQuery>>();
    for (const read of planned.transcript.replayReads ?? []) {
      if (read.scope === targetScope) continue; // validated locally
      const replays = replaysByOwner.get(read.scope) ?? new Map<string, ReplayPageQuery>();
      replays.set(replayPageQueryKey(read), { space: read.space, from: read.from, limit: read.limit });
      replaysByOwner.set(read.scope, replays);
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
      const replayQueries = replaysByOwner.get(owner);
      const reply = await this.host.rpc(this.destinationFor(request, owner), "/attest", {
        keys: [...keys].sort(),
        ...(orderingParents && orderingParents.size > 0
          ? { ordering_parents: [...orderingParents.values()].sort((a, b) => orderedProjectionKey(a.container, a.parent).localeCompare(orderedProjectionKey(b.container, b.parent))) }
          : {}),
        ...(replayQueries && replayQueries.size > 0
          ? { replay_pages: [...replayQueries.values()].sort((a, b) => replayPageQueryKey(a).localeCompare(replayPageQueryKey(b))) }
          : {})
      }) as {
        catalog_epoch?: string;
        owner_head: ScopeHead;
        cells: Array<{ key: string; version: string }>;
        orderings?: Array<{ container: string; parent: string | null; version: string }>;
        replays?: Array<{ space: string; from: number; limit: number; version: string }>;
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
      if (replayQueries && replayQueries.size > 0) {
        const attestedPages = new Map<string, string>();
        for (const page of reply.replays ?? []) {
          if (!validReplayPageQuery(page)
            || typeof page.version !== "string" || page.version.length === 0) {
            throw new Error(`attestation from ${owner} returned a malformed replay-page version`);
          }
          attestedPages.set(replayPageQueryKey(page), page.version);
        }
        for (const query of replayQueries.values()) {
          if (!attestedPages.has(replayPageQueryKey(query))) {
            throw new Error(`attestation from ${owner} omitted replay page ${query.space}@${query.from}+${query.limit}`);
          }
        }
      }
      return reply;
    };
    const canReuse = (
      owner: string,
      keys: Set<string>,
      entry: NonNullable<CommitSubmit["attestations"]>[string] | undefined
    ): entry is NonNullable<CommitSubmit["attestations"]>[string] => {
      if (!entry) return false;
      const expectedCells = cellVersionsByOwner.get(owner);
      const cells = new Map(entry.cells.map((cell) => [cell.key, cell.version]));
      for (const key of keys) {
        const expected = expectedCells?.get(key);
        if (expected === undefined || cells.get(key) !== expected) return false;
      }

      const orderings = new Map(
        (entry.orderings ?? []).map((ordering) => [
          orderedProjectionKey(ordering.container, ordering.parent),
          ordering.version
        ])
      );
      for (const read of planned.transcript.orderingReads ?? []) {
        if (read.scope !== owner || read.scope === targetScope) continue;
        if (orderings.get(orderedProjectionKey(read.container, read.parent)) !== read.version) return false;
      }

      const replays = new Map(
        (entry.replays ?? []).map((page) => [replayPageQueryKey(page), page.version])
      );
      for (const read of planned.transcript.replayReads ?? []) {
        if (read.scope !== owner || read.scope === targetScope) continue;
        if (replays.get(replayPageQueryKey(read)) !== read.version) return false;
      }
      return true;
    };

    const attestations: NonNullable<CommitSubmit["attestations"]> = {};
    const liveOwners: Array<[string, Set<string>]> = [];
    for (const [owner, keys] of owners) {
      const prior = reusable?.[owner];
      if (canReuse(owner, keys, prior)) {
        // Carry only what the new transcript still requires. Besides keeping
        // the wire envelope bounded, pruning prevents a stale extra cell from
        // a prior owner entry competing with the same globally unique key if
        // refreshed topology reclassifies another read during the re-plan.
        const requiredOrderings = orderingsByOwner.get(owner);
        const requiredReplays = replaysByOwner.get(owner);
        const orderings = (prior.orderings ?? []).filter((ordering) =>
          requiredOrderings?.has(orderedProjectionKey(ordering.container, ordering.parent))
        );
        const replays = (prior.replays ?? []).filter((page) =>
          requiredReplays?.has(replayPageQueryKey(page))
        );
        attestations[owner] = {
          owner_head: prior.owner_head,
          cells: prior.cells.filter((cell) => keys.has(cell.key)),
          ...(orderings.length > 0 ? { orderings } : {}),
          ...(replays.length > 0 ? { replays } : {})
        };
      } else {
        liveOwners.push([owner, keys]);
      }
    }
    const actions: Array<() => Promise<unknown>> = liveOwners.map(([owner, keys]) => () => attest(owner, keys));
    const replies = structure
      ? await structure.rpcGroup(actions, { phase: "attest" })
      : await Promise.all(actions.map((action) => action()));
    liveOwners.forEach(([owner], index) => {
      const reply = replies[index] as { owner_head: ScopeHead; cells: Array<{ key: string; version: string }>; orderings?: Array<{ container: string; parent: string | null; version: string }>; replays?: Array<{ space: string; from: number; limit: number; version: string }> };
      attestations[owner] = {
        owner_head: reply.owner_head,
        cells: reply.cells,
        ...(reply.orderings && reply.orderings.length > 0 ? { orderings: reply.orderings } : {}),
        ...(reply.replays && reply.replays.length > 0 ? { replays: reply.replays } : {})
      };
    });
    if (immutableCatalogKeys.size > 0) {
      const certified = this.epochCatalogAttestation(request, view, immutableCatalogKeys);
      const live = attestations[CATALOG_SCOPE];
      attestations[CATALOG_SCOPE] = live
        // Merge certified definition cells INTO the live attestation —
        // preserving any ordering/replay attestations it carries.
        ? { ...live, cells: [...live.cells, ...certified.cells] }
        : certified;
    }
    return attestations;
  }

  /**
   * Compare a plan with the owner attestations fetched for this exact round.
   *
   * Only keys actually present in the attestation envelope participate.
   * Locally owned reads and session reads proven by a room presence checkpoint
   * intentionally have no foreign entry and still go to normal scope
   * validation. The returned TranscriptCells are byte-for-byte the repair
   * input the scope would place in `mismatched_reads`.
   */
  private foreignAttestationMismatches(
    planned: PlanTurnResult,
    attestations: CommitSubmit["attestations"]
  ): EffectTranscript["reads"][number]["cell"][] {
    if (!attestations) return [];
    const currentVersions = new Map<string, string>();
    for (const attestation of Object.values(attestations)) {
      for (const cell of attestation.cells) currentVersions.set(cell.key, cell.version);
    }
    const mismatched: EffectTranscript["reads"][number]["cell"][] = [];
    const seen = new Set<string>();
    for (const read of planned.transcript.reads) {
      const key = netCellKeyFor(read.cell);
      if (key === null || seen.has(key) || !currentVersions.has(key)) continue;
      if (currentVersions.get(key) !== String(read.version)) {
        mismatched.push(read.cell);
        seen.add(key);
      }
    }
    return mismatched;
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

  /** CO13 affected-owner directions for the committing scope: the
   * transcript's relation OWNER objects — move sources/destinations,
   * create locations, contents-write containers, session-transition
   * rooms — plus recorded observation audiences. Relation owners are
   * classified by the same walk route.ts selects scopes with; observation
   * indexes use events.md §12.7's semantic call-space/source-space rule.
   * The scope shell feeds relation objects to the sequencer's delta
   * partition (`scopeOf`) and addresses one combined /net/relate outbox row
   * per foreign owner. Anchor topology stays gateway knowledge (the
   * rider_destinations rule). An owner the classifier cannot place falls
   * back to the planning scope inside `classifierFor`, so a same-turn-created
   * container classifies with the turn, never as a spurious foreign owner. */
  private relateDestinationsFor(
    request: TurnRequest,
    classifier: ScopeClassifier,
    planned: PlanTurnResult,
    targetScope: string
  ): Record<string, { destination: string; objects: string[]; observation_indexes?: number[] }> {
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

    // A sequenced call may commit away from its semantic space when every
    // domain write belongs to another authority. The durable observation
    // still has the call-space audience (events.md §12.7), so tell the
    // committing scope which foreign owner must receive each observation.
    // This is especially important for rolling/aged catalog pages that write
    // an anchored actor directly instead of folding a room-owned projection.
    //
    // A source that is ACTUALLY a self-sequenced semantic space wins. Merely
    // belonging to a shared scope is insufficient: ordinary room-anchored
    // items also classify there, but events.md §12.7 says their observations
    // retain the call-space audience. CO15 names a self-sequenced space's
    // scope `room:<its own id>`, which proves the role without teaching the
    // gateway a catalog class literal. Relation-owner observations may appear
    // in both maps; enqueueDeliveries merges them by index before creating one
    // idempotent /relate row.
    const observationIndexesByScope = new Map<string, number[]>();
    if (planned.transcript.route === "sequenced") {
      planned.transcript.observations.forEach((observation, index) => {
        const record =
          observation !== null && typeof observation === "object" && !Array.isArray(observation)
            ? observation as { source?: unknown }
            : null;
        let scope = request.planningScope;
        const source = record?.source;
        if (typeof source === "string") {
          try {
            const classified = classifier.scopeOf(source);
            if (classifier.isShared(classified) && classified === `room:${source}`) scope = classified;
          } catch {
            // Sparse planning may not hold an optional source's complete
            // anchor chain. The sequenced call space remains the normative
            // fallback audience.
          }
        }
        if (scope === targetScope) return;
        const indexes = observationIndexesByScope.get(scope) ?? [];
        indexes.push(index);
        observationIndexesByScope.set(scope, indexes);
      });
    }

    const out: Record<string, { destination: string; objects: string[]; observation_indexes?: number[] }> = {};
    const scopes = new Set([...objectsByScope.keys(), ...observationIndexesByScope.keys()]);
    for (const scope of [...scopes].sort()) {
      const objects = objectsByScope.get(scope) ?? new Set<string>();
      const observationIndexes = observationIndexesByScope.get(scope) ?? [];
      out[scope] = {
        destination: this.destinationFor(request, scope),
        objects: [...objects].sort(),
        ...(observationIndexes.length > 0 ? { observation_indexes: observationIndexes } : {})
      };
    }
    return out;
  }

  /** One planning pass against the current view. The provisional base is
   * patched after the head fetch — `base` is an envelope field, not part
   * of the transcript hash. */
  private async planOnce(
    request: TurnRequest,
    view: CellStore,
    classifier: ScopeClassifier,
    objectCounter?: number,
    planningRoomRoster?: { room: string; rows: readonly RoomRosterRow[] },
    seedObjects?: ReadonlySet<string>,
    planningOrderedChildren?: readonly PlanningOrderedChildrenProjection[],
    planningOrderedNeighbors?: readonly PlanningOrderedNeighborsProjection[],
    planningReplayPages?: readonly PlanningReplayPageProjection[],
    compactOwnedReads = false
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
      ...(request.retry_receipt === true ? { retryReceipt: true } : {}),
      stamp: { scope_head: "gateway", catalog_epoch: request.catalog_epoch },
      // Repaired objects ride into the seed slice so a re-plan keeps the
      // cells a prior round pulled (see PlanTurnInput.seedObjects).
      ...(seedObjects && seedObjects.size > 0 ? { seedObjects } : {}),
      // Phase 1: the gateway turn path plans against the read-set SLICE
      // (built from the actor/session/target closure via the view's
      // object/session indexes, slice-cloned per attempt, grown on a
      // miss), so the planner world AND the fix-6 snapshot are
      // O(read-set), not O(view).
      slicePlanning: true,
      ...(planningRoomRoster ? { planningRoomRoster } : {}),
      ...(planningOrderedChildren && planningOrderedChildren.length > 0 ? { planningOrderedChildren } : {}),
      ...(planningOrderedNeighbors && planningOrderedNeighbors.length > 0 ? { planningOrderedNeighbors } : {}),
      ...(planningReplayPages && planningReplayPages.length > 0 ? { planningReplayPages } : {}),
      ...(compactOwnedReads ? { compactOwnedReads: { scope: request.planningScope } } : {}),
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
  private async scopeHead(destination: string): Promise<PlanningHead> {
    return (await this.host.rpc(destination, "/head")) as PlanningHead;
  }

  /** Read and LRU-touch one optimistic planning hint. Epoch skew is a miss,
   * never a reason to let the fail-fast check consume a prior catalog's
   * derived counter. */
  private cachedPlanningHead(scope: string, epoch: string): PlanningHead | null {
    const cached = this.planningHeads.get(scope);
    if (cached === undefined) return null;
    if (cached.catalog_epoch !== undefined && cached.catalog_epoch !== epoch) {
      this.planningHeads.delete(scope);
      return null;
    }
    this.planningHeads.delete(scope);
    this.planningHeads.set(scope, cached);
    return cached;
  }

  private rememberPlanningHead(scope: string, epoch: string, head: PlanningHead): void {
    const cached = {
      ...head,
      // Production /head always carries the epoch. Fixture replies may omit
      // it; stamp the epoch whose turn validated the reply so it cannot cross
      // a later catalog activation inside this gateway.
      catalog_epoch: head.catalog_epoch ?? epoch
    };
    this.planningHeads.delete(scope);
    this.planningHeads.set(scope, cached);
    while (this.planningHeads.size > PLANNING_HEAD_CACHE_CAP) {
      const oldest = this.planningHeads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.planningHeads.delete(oldest);
    }
  }

  private forgetPlanningHead(scope: string): void {
    this.planningHeads.delete(scope);
  }

  /** A head-stable direct turn preserves the cached allocation floor. Any
   * changed authority head discards it; the next turn pays /head and learns
   * the matching counter before it can plan a create. */
  private reconcilePlanningHead(scope: string, epoch: string, accepted: ScopeHead): void {
    const cached = this.planningHeads.get(scope);
    if (
      cached === undefined
      || cached.catalog_epoch !== epoch
      || cached.head.seq !== accepted.seq
      || cached.head.hash !== accepted.hash
      || cached.head.generation !== accepted.generation
    ) {
      this.forgetPlanningHead(scope);
    }
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
    )) as CellTransfer & { scope?: string };
    const wanted = new Set(touched);
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        const installed = this.installTransferredCells(
          view,
          transfer.cells,
          typeof transfer.scope === "string" ? transfer.scope : undefined
        );
        for (const key of installed) wanted.delete(key);
        for (const key of wanted) {
          view.delete(key);
          this.persistCell(view, key);
        }
      })
    );
    if (typeof transfer.scope === "string") this.completeHeads.delete(transfer.scope);
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
    catalogEpoch: string,
    clusterScope: string
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
      this.persistCell(view, cell.key, clusterScope);
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
  ): Promise<Map<string, AuthorityReadReceipt>> {
    const receipts = new Map<string, AuthorityReadReceipt>();
    if (keys.length === 0) return receipts;
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
    const expectedScopeByKey = new Map<string, string>();
    const unknownOwner: string[] = [];
    for (const key of keys) {
      const object = objectOfCellKey(key);
      if (key.startsWith("session:")) {
        const expectedScope = classifier.scopeOf(request.call.actor);
        const destination = this.destinationFor(request, expectedScope);
        byDestination.set(destination, [...(byDestination.get(destination) ?? []), key]);
        expectedScopeByKey.set(key, expectedScope);
      } else if (view.has(cellKey("object_lineage", object))) {
        const expectedScope = classifier.scopeOf(object);
        const destination = this.destinationFor(request, expectedScope);
        byDestination.set(destination, [...(byDestination.get(destination) ?? []), key]);
        expectedScopeByKey.set(key, expectedScope);
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
          const sourceScope = typeof (transfer as AuthorityCellTransfer).scope === "string"
            ? (transfer as AuthorityCellTransfer).scope as string
            : undefined;
          const installed = this.installTransferredCells(view, transfer.cells, sourceScope);
          for (const key of installed) wanted.delete(key);
          for (const key of wanted) {
            view.delete(key);
            this.persistCell(view, key);
          }
        })
      );
      const authority = transfer as AuthorityCellTransfer;
      if (typeof authority.scope === "string" && validScopeHead(authority.head)) {
        const { scope, head } = authority;
        for (const key of want) {
          // A destination override may accidentally alias two logical scopes.
          // Only the scope that classification selected can attest this key.
          if (expectedScopeByKey.get(key) === scope && authorityCellReceiptEligible(key, head)) {
            receipts.set(key, { scope, head, version: view.get(key)?.version ?? "absent" });
          }
        }
      }
    });
    if (unknownOwner.length === 0) return receipts;
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
              const sourceScope = typeof (transfer as AuthorityCellTransfer).scope === "string"
                ? (transfer as AuthorityCellTransfer).scope as string
                : undefined;
              this.installTransferredCells(view, transfer.cells, sourceScope);
            })
          );
          // A nonempty convention probe only proves ownership when the
          // object's own lineage page is authoritative at the responding
          // scope. Rider residue or unrelated closure cells may warm the view,
          // but must not authorize a terminal non-convergence verdict.
          const ownerLineage = transfer.cells.find((cell) =>
            cell.key === cellKey("object_lineage", object) && cell.provenance === "authoritative"
          );
          const authority = transfer as AuthorityCellTransfer;
          if (ownerLineage && typeof authority.scope === "string" && validScopeHead(authority.head)) {
            const { scope, head } = authority;
            for (const key of want) {
              if (authorityCellReceiptEligible(key, head)) {
                receipts.set(key, { scope, head, version: view.get(key)?.version ?? "absent" });
              }
            }
          }
          satisfied = true;
        } catch (err) {
          // NC8b: a budget refusal is the TURN's verdict, not a probe miss.
          if (isNetError(err) && err.code === "E_BUDGET") throw err;
          // A candidate that is not a real scope (no durable state)
          // refuses — expected for convention probes; try the next.
        }
      }
    }
    return receipts;
  }

  /** Full-closure install from the scope — the CO8 named reseed and the
   * /net/pull live path share this. */
  /**
   * Phase 4 targeted warming: pull ONLY the named objects' cells (each
   * with its class chain, expanded at the authority) plus the scope's
   * relation rows, and advance the fanout high-water to the returned
   * head. Advancing is safe because the returned relation family is
   * complete and replaces that scope's mirror rows before the advance.
   * Unrequested cells receive no completeness certificate; pull-on-miss
   * and read-version checks own them. This is the client cold-open path:
   * its cost tracks what the
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
    if (advanceSeen && transfer.relations === undefined) {
      throw new Error(`targeted closure for ${transfer.scope} omitted its complete relation family`);
    }
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        this.installTransferredCells(view, transfer.cells, transfer.scope, undefined, true);
        if (advanceSeen) {
          this.replaceScopeRelations(transfer.scope, transfer.relations ?? []);
          this.advanceSeen(transfer.scope, transfer.head.seq);
        }
      })
    );
    if (advanceSeen) this.completeHeads.delete(transfer.scope);
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
    if (transfer.relations === undefined) {
      throw new Error(`full closure for ${transfer.scope} omitted its complete relation family`);
    }
    this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        // `keys: ["*"]` is exact for every cell this scope owns. `known`
        // only relieves foreign lineage closure; it never filters the scope's
        // own requested keys, so replacement remains required.
        this.replaceScopeCells(view, transfer.scope, transfer.cells);
        this.replaceScopeRelations(transfer.scope, transfer.relations ?? []);
        // The closure image and its high-water advance are one durable
        // replacement. A stale pre-pull fanout then no-ops without
        // preserving any member deleted before this exact head.
        this.advanceSeen(transfer.scope, transfer.head.seq);
      })
    );
    if (known.length === 0) this.completeHeads.set(transfer.scope, transfer.head);
    return transfer;
  }

  /** One classifier over the already-installed transfer image. Building it
   * after every cell is present lets a child that sorts before its anchor use
   * the same closed lineage as planning, while the classifier's memo keeps the
   * ownership materialization proportional to the transferred object graph. */
  private viewClassifier(view: CellStore): ScopeClassifier {
    return classifierFromLineage(
      (object) => (view.get(cellKey("object_lineage", object))?.value as AnchorLineage | undefined) ?? null
    );
  }

  /** Durable owner of one transferred cache cell.
   *
   * Normal object and session cells are classified from the transfer's closed
   * lineage. Source-authoritative cells may use the responding scope as their
   * fallback (logs have no lineage by definition). A derived rider may NOT use
   * that fallback: falsely assigning a foreign stale row to the pulled scope
   * could let a later pull of its real owner certify it. An unclassifiable
   * derived rider returns null and is discarded as a repairable cache miss. */
  private transferredCellOwnerScope(
    cell: Cell,
    sourceScope: string | undefined,
    classifier: ScopeClassifier
  ): string | null {
    if (cell.kind === "log") {
      if (sourceScope !== undefined) return sourceScope;
      throw netError("E_LINEAGE", "transferred log cell has no source scope", { key: cell.key });
    }
    const sessionActor = cell.kind === "session"
      ? (cell.value as { actor?: unknown } | null | undefined)?.actor
      : undefined;
    const object = cell.kind === "session"
      ? (typeof sessionActor === "string" && sessionActor.length > 0 ? sessionActor : null)
      : cell.object;
    if (object !== null) {
      try {
        return classifier.scopeOf(object);
      } catch {
        if (cell.provenance !== "authoritative") return null;
      }
    }
    if (cell.provenance === "authoritative" && sourceScope !== undefined) return sourceScope;
    // A scope may carry foreign rider residue whose lineage lives only at its
    // real owner. Without that lineage this gateway cannot assign an owner
    // safely. The row is only a derived cache, so dropping it is conservative:
    // a later read repairs from authority, while retaining it could eventually
    // let the real owner's complete-head certificate bless a stale value.
    return null;
  }

  /** Install and persist one closure/fanout cell family with a non-null,
   * indexed owner scope. `installedProvenance` changes only the cache copy's
   * provenance (KV seed); ownership still uses the wire cell so the source's
   * authoritative marker remains available for the safe fallback above. */
  private installTransferredCells(
    view: CellStore,
    cells: readonly Cell[],
    sourceScope?: string,
    installedProvenance?: Cell["provenance"],
    invalidatePresentation = false
  ): Set<string> {
    for (const cell of cells) {
      if (invalidatePresentation) this.invalidateRoomPresentationActor(cell);
      view.install(installedProvenance === undefined ? cell : { ...cell, provenance: installedProvenance });
    }
    const classifier = this.viewClassifier(view);
    const installed = new Set<string>();
    for (const cell of cells) {
      const ownerScope = this.transferredCellOwnerScope(cell, sourceScope, classifier);
      if (ownerScope === null) {
        view.delete(cell.key);
        this.persistCell(view, cell.key);
      } else {
        this.persistCell(view, cell.key, ownerScope);
        installed.add(cell.key);
      }
    }
    return installed;
  }

  /** Install one unfiltered scope closure as an EXACT replacement.
   *
   * `completeHeads` lets the planner omit every ordinary read whose object
   * the CO15 classifier assigns to this scope. Therefore the same ownership
   * rule defines the negative half of the certificate: any locally held cell
   * assigned to `scope` but absent from the transfer must be deleted before
   * the certificate is installed. Session cells classify through the actor
   * named in their value, matching CO14 partitioning; this also prevents an
   * exact cluster pull from retaining an expired authentication row.
   *
   * `owner_scope` is materialized on every cache install, so the negative set
   * is one indexed query over this scope's rows — never a gateway-wide scan.
   * Full repair therefore stays O(scope image), the CO11 bound. */
  private replaceScopeCells(
    view: CellStore,
    scope: string,
    cells: readonly Cell[],
    installedProvenance?: Cell["provenance"]
  ): void {
    const present = this.installTransferredCells(view, cells, scope, installedProvenance);
    const owned = sqlRows<{ key: string }>(
      this.state.storage.sql.exec("SELECT key FROM net_gateway_cell WHERE owner_scope = ?", scope)
    );
    for (const { key } of owned) {
      if (present.has(key)) continue;
      this.invalidateRoomPresentationActorKey(key);
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

  /** Advance only the subscriber-lane continuity watermark.
   *
   * `/net/subscribe` returns the acknowledged prefix immediately before the
   * gateway performs its state backfill. Persist that prefix independently of
   * the authority `seen_seq`: the following pull owns state freshness, while
   * pending fanout rows own every delivery position above this watermark. */
  private advanceDeliverySeen(scope: string, seq: number): void {
    this.ensureView(); // Hydrates the durable high-water maps before max().
    const last = this.deliverySeen.get(scope) ?? 0;
    if (seq <= last) return;
    this.state.storage.sql.exec(
      "INSERT INTO net_gateway_scope (scope, seen_seq, delivery_seen_seq) VALUES (?, 0, ?) ON CONFLICT(scope) DO UPDATE SET delivery_seen_seq = MAX(delivery_seen_seq, excluded.delivery_seen_seq)",
      scope,
      seq
    );
    this.deliverySeen.set(scope, seq);
  }

  /** Close the subscribe/delivery race and report only a proven lane gap. */
  private finishDeliveryResume(scope: string, resumeDeliverySeq: number): void {
    const resuming = this.deliveryResumes.get(scope);
    this.deliveryResumes.delete(scope);
    if (
      resuming?.firstDeliverySeq !== undefined
      && resuming.firstDeliverySeq > resumeDeliverySeq + 1
    ) {
      this.reportFanoutGap(
        scope,
        resumeDeliverySeq + 1,
        resuming.firstDeliverySeq,
        resuming.firstAuthoritySeq ?? 0
      );
    }
  }

  /** One normalized integrity event for ordinary and subscribe-race gaps. */
  private reportFanoutGap(scope: string, expected: number, got: number, authoritySeq: number): void {
    this.metric({
      kind: "net_fanout_gap",
      scope,
      status: "error",
      error: "E_FANOUT_GAP",
      expected,
      got,
      reason: `authority_seq:${authoritySeq}`
    });
  }

  /** CO2.5 receiver idempotency + copy-#2 persistence, one transaction. */
  private receiveFanout(body: FanoutBody): boolean {
    const view = this.ensureView();
    const completeBefore = this.completeHeads.get(body.scope);
    // Delivery continuity is per subscriber lane, not per authority head:
    // an authority event can validly produce no row for this destination.
    // Unstamped bodies are accepted for rolling-upgrade compatibility.
    const lastDelivery = this.deliverySeen.get(body.scope) ?? 0;
    if (body.delivery_seq !== undefined && body.delivery_seq > lastDelivery + 1) {
      const resuming = this.deliveryResumes.get(body.scope);
      if (resuming) {
        if (
          resuming.firstDeliverySeq === undefined
          || body.delivery_seq < resuming.firstDeliverySeq
        ) {
          resuming.firstDeliverySeq = body.delivery_seq;
          resuming.firstAuthoritySeq = body.seq;
        }
      } else {
        this.reportFanoutGap(body.scope, lastDelivery + 1, body.delivery_seq, body.seq);
      }
    }
    const applied = this.discardViewOnThrow(() =>
      this.state.storage.transactionSync(() => {
        const advanced = applyFanout(view, this.seen, body);
        if (body.delivery_seq !== undefined && body.delivery_seq > lastDelivery) {
          this.deliverySeen.set(body.scope, body.delivery_seq);
        }
        if (advanced) {
          const classifier = this.viewClassifier(view);
          for (const cell of body.cells) {
            this.invalidateRoomPresentationActor(cell);
            const ownerScope = this.transferredCellOwnerScope(cell, body.scope, classifier);
            if (ownerScope === null) {
              view.delete(cell.key);
              this.persistCell(view, cell.key);
            } else {
              this.persistCell(view, cell.key, ownerScope);
            }
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
          for (const delta of body.relations ?? []) this.applyRelationDelta(delta, body.scope);
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
      // The authority advanced beyond any planning hint retained for this
      // scope. Invalidate before callbacks can start another turn; a missing
      // fanout is still safe because /submit validates the retained base,
      // current reads, and post-state before accepting.
      this.forgetPlanningHead(body.scope);
      if (
        completeBefore &&
        body.seq === completeBefore.seq + 1 &&
        typeof body.head_hash === "string" &&
        body.head_hash.length > 0 &&
        typeof body.head_generation === "number"
      ) {
        this.completeHeads.set(body.scope, {
          seq: body.seq,
          hash: body.head_hash,
          generation: body.head_generation
        });
      } else {
        this.completeHeads.delete(body.scope);
      }
      // Descriptor freshness follows the same committed/fanout-coherent view
      // as invocation. Run before observation delivery so a movement's new
      // presence row can notify its own session even when echo dedupe suppresses
      // that session's observation frame.
      this.mcpRefreshToolListHints(body);
      this.pushObservations(body);
    }
    return applied;
  }

  /** Replace exactly one scope's relation family before advancing its
   * fanout high-water. `owner_scope` is materialized from the authoritative
   * transfer source, so the indexed delete never enumerates other scopes.
   * The v2 cache migration discarded pre-owner_scope rows and their matching
   * high-waters, so there is no unindexed legacy residue to scan here. */
  private replaceScopeRelations(scope: string, rows: readonly RelationRow[]): void {
    const present = new Set(rows.map((row) => relationKey(row.relation, row.owner, row.member)));
    const owned = sqlRows<{ key: string }>(
      this.state.storage.sql.exec("SELECT key FROM net_gateway_relation WHERE owner_scope = ?", scope)
    );
    for (const { key } of owned) {
      if (!present.has(key)) this.state.storage.sql.exec("DELETE FROM net_gateway_relation WHERE key = ?", key);
    }
    for (const row of rows) this.applyRelationDelta({ op: "add", row }, scope);
  }

  /** One relation delta into the mirror table (add = upsert, remove =
   * delete; both idempotent, matching applyRelationDeltas' semantics at
   * the owning scope). The fanout/closure source is the authoritative owner
   * scope and is materialized on every row. */
  private applyRelationDelta(delta: RelationDelta, sourceScope: string): void {
    const key = relationKey(delta.row.relation, delta.row.owner, delta.row.member);
    if (delta.op === "add") {
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_relation (key, relation, owner, member, body, owner_scope, member_scope) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, owner_scope = excluded.owner_scope, member_scope = excluded.member_scope",
        key,
        delta.row.relation,
        delta.row.owner,
        delta.row.member,
        delta.row.body !== undefined ? JSON.stringify(delta.row.body) : null,
        sourceScope,
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
      this.liveSeen.clear();
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
    for (const row of sqlRows<{ scope: string; seen_seq: number; delivery_seen_seq: number; live_seq: number } & ScopeRow>(
      this.state.storage.sql.exec("SELECT scope, seen_seq, delivery_seen_seq, live_seq FROM net_gateway_scope")
    )) {
      this.seen.set(row.scope, row.seen_seq);
      this.deliverySeen.set(row.scope, row.delivery_seen_seq);
      this.liveSeen.set(row.scope, Number(row.live_seq ?? 0));
    }
    this.view = view;
    return view;
  }

  /** Write-through for one view cell (installed or deleted). Inserts require
   * their materialized authority scope: exact full-pull replacement relies on
   * this index and must never fall back to a gateway-wide classification scan. */
  private persistCell(view: CellStore, key: string, ownerScope?: string): void {
    const cell = view.get(key);
    if (cell) {
      if (ownerScope === undefined) {
        throw netError("E_LINEAGE", "gateway cell insert omitted owner scope", { key });
      }
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_cell (key, body, owner_scope) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, owner_scope = excluded.owner_scope",
        key,
        JSON.stringify(cell),
        ownerScope
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
/** Bounded per-session `woo_wait` parking (M5). One outstanding long-poll is
 * the well-behaved shape; the slack covers a retry in flight. */
const MCP_MAX_SESSION_WAITS = 4;

const MCP_QUEUE_CAP = 256;
const MCP_SESSION_STATE_CAP = 512;
/** Conservative SQLite bind chunk for scope ∩ local-carrier queries. */
const GATEWAY_CARRIER_QUERY_CHUNK = 64;
const MCP_STANDARD_TOOL_PAGE = 128;
const MCP_DISCOVERY_DEFAULT_PAGE = 64;
/** Longest doc-comment paragraph carried into a tool description. */
const MCP_DESCRIPTION_CAP = 500;
const MCP_DISCOVERY_MAX_PAGE = 256;
const MCP_CONTEXT_WARM_FAILURE_CAP = 512;
const MCP_CONTEXT_WARM_SUCCESS_CAP = 512;
const MCP_SSE_LISTEN_MS = 25_000;
/**
 * Live standalone GET/SSE listens per session (mcp.md M6).
 *
 * `woo_wait` is capped per session, but each authenticated GET used to append
 * another ~25-second waiter with no limit at all: the per-actor rate bucket
 * alone permits on the order of 1,250 concurrent listens inside one listen
 * window, every one of them holding a stream controller and a timer.
 *
 * Streamable HTTP gives a client exactly one standalone stream, so the cap is
 * small; the slack covers a reconnect that overlaps the stream it replaces.
 * Over the cap the OLDEST listen is CLOSED to admit the new one — see
 * clientMcpEvents for why replacement rather than refusal.
 */
const MCP_MAX_SESSION_SSE = 2;
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
  /** Parked `woo_wait` calls. Keyed by the class-discriminated JSON-RPC
   * request id (`mcpRequestKey`) so an explicit `notifications/cancelled` can
   * release exactly one, and BOUNDED (MCP_MAX_SESSION_WAITS) because this is
   * a public surface: without a cap a client could park closures and timers
   * without limit. */
  waiters: NetMcpWaiter[];
  ownEchoIds: Set<string>;
  /** M5.1 continuity marker. True when this gateway cannot prove that the
   * session's queue has been continuous since the client's last drain —
   * a rebuilt (evicted/restarted) state, or a bounded-buffer overflow.
   * Cleared by the woo_wait reply that carries it. */
  gapPending: boolean;
  toolListDigest: string | null;
  listChangedDirty: boolean;
  listChangedPending: boolean;
  /** Live standalone GET/SSE listens. Bounded by MCP_MAX_SESSION_SSE for the
   * same reason `waiters` is: each holds a stream controller and a 25s timer.
   * Oldest-first, so admitting one over the cap evicts from the front. */
  sseWaiters: NetMcpSseWaiter[];
};

/** One parked woo_wait. `wake(cancelled)` resolves it; a cancelled wake must
 * NOT drain, or a client that walked away would consume rows it never read. */
type NetMcpWaiter = { requestKey: string; wake: (cancelled: boolean) => void };

function mcpSessionState(actor: string): NetMcpSessionState {
  return {
    actor,
    buffer: [],
    waiters: [],
    ownEchoIds: new Set(),
    gapPending: false,
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
 * from using a reachable MCP endpoint as a DNS-rebinding / cross-site target.
 *
 * The comparison is against the EDGE-ASSERTED public origin, never this DO's
 * own request URL: the edge rewrites the URL to `https://do/...`, so comparing
 * against it refused every browser and admitted every headless client — the
 * exact inversion of the intended property. See src/worker/public-origin.ts
 * for the header's trust model and the admission rule. */
function rejectForeignMcpOrigin(request: Request, env: NetGatewayEnv): Response | null {
  const decision = mcpOriginDecision({
    origin: request.headers.get("origin"),
    publicOrigin: request.headers.get(PUBLIC_ORIGIN_HEADER),
    configured: env.WOO_MCP_ALLOWED_ORIGINS
  });
  if (decision === "allow") return null;
  return json({ error: { code: "E_PERM", message: "foreign MCP Origin is not allowed" } }, 403);
}

// "all" is intentionally NOT a scope. It had no branch in mcpToolPage and
// silently fell through to the local structural closure (identical to
// "active"), implying a global tool enumeration that Big-World forbids
// (spec/semantics/distribution.md). Removed so a caller asking for "all" gets a
// clear error instead of a misleading partial view.
type NetMcpToolScope = "active" | "here" | "object" | "space";

type NetMcpToolDraft = {
  object: string;
  /** The class or feature ancestor holding the page. Verb-name resolution is
   * per-definer, so this is load-bearing for mcpMatchVerb, not decoration. */
  definer: string;
  /** Definition order within `definer` — the dispatcher's second ordering
   * key. `null` when the view's page carries none; mcpMatchVerb refuses
   * rather than guessing when that absence could change the answer. */
  slot: number | null;
  verb: string;
  /** Transport route derived from catalog command persistence. This stays
   * internal: clients invoke one capability; the gateway preserves its
   * declared live/durable semantics. */
  route: "direct" | "sequenced";
  aliases: string[];
  /** Verb source, kept raw: the description is rendered from it only for
   * pages that survive the listing gates. */
  source: string;
  /** Compiler-owned argument metadata, kept raw for the same reason. */
  argSpec: Record<string, unknown>;
  /** Bytecode-backed. A native page has no portable Net execution body. */
  bytecode: boolean;
  /** The page's raw perm string, for a refusal that can name the gate. */
  perms: string;
  /** Listing gate only: `tool_exposed`, or command-shaped on the active
   * command surface. It has no bearing on `woo_call` (M2.1). */
  exposed: boolean;
  /** Generic execute-permission prefilter; the authoritative turn re-checks. */
  executable: boolean;
  /** Ingress flag consumed by the `direct` route (core.md C12.2). */
  directCallable: boolean;
};

/** A draft plus its rendered presentation: the tool name, the derived input
 * schema and positional argument order, and the description (the verb's first
 * doc paragraph followed by the canonical call form). */
type NetMcpDynamicTool = NetMcpToolDraft & {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  argNames: string[];
};

type NetMcpToolPage = {
  scope: NetMcpToolScope;
  activeScope: string | null;
  object: string | null;
  query: string | null;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  tools: NetMcpDynamicTool[];
  /** The complete canonical descriptor set the page was projected from, and
   * the structural context it was computed over. Carried so the caller can
   * re-baseline the tools/list digest without recomputing the whole listing.
   * NOT part of the client reply. */
  canonical: NetMcpDynamicTool[];
  context: Set<string>;
};

function mcpRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The client-stable operation id for a `tools/call` (mcp.md §M4.2).
 *
 * TWO carriers, because neither one alone is both universal and legible:
 *
 * - `params._meta["woo.net/operation_id"]` is the protocol-level carrier.
 *   `_meta` is MCP's sanctioned per-request extension point, it can never
 *   collide with a verb's own argument names, and it survives the 2026-07-28
 *   stateless revision — where `initialize` and the protocol session are gone
 *   but `_meta` becomes REQUIRED on every request. It takes precedence.
 * - `arguments.operation_id` is the legible carrier. `_meta` is invisible to
 *   a model: nothing in `tools/list` advertises it, so an agent client would
 *   never populate it. A declared input-schema property is the only form an
 *   LLM client reliably fills in, and a fix nobody uses is not a fix.
 *
 * Collision rule: a verb that declares its OWN `operation_id` parameter owns
 * that name. For those tools the argument stays a domain value and only
 * `_meta` carries the operation id — the schema advertises it accordingly.
 * `woo_call` passes verb arguments positionally inside `args`, so its own
 * argument namespace can never collide.
 */
const MCP_OPERATION_ID_META = "woo.net/operation_id";
const MCP_OPERATION_ID_ARG = "operation_id";
/** Bounded and opaque: long enough for a UUID or a `<run>:<step>` pair, and
 * restricted so a key can never carry structure the turn key would confuse.
 * Runtime object ids contain no `:` (isConcreteRuntimeObjectId), so
 * `mcp:<actor>:<operation_id>` stays injective in (actor, operation id). */
const MCP_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type McpOperationId =
  | { ok: true; value: string | null }
  | { ok: false; error: Record<string, unknown> };

function mcpOperationId(
  params: Record<string, unknown>,
  args: Record<string, unknown>,
  declaredArgNames: readonly string[]
): McpOperationId {
  const meta = mcpRecord(params._meta);
  const fromMeta = meta[MCP_OPERATION_ID_META];
  const fromArg = declaredArgNames.includes(MCP_OPERATION_ID_ARG) ? undefined : args[MCP_OPERATION_ID_ARG];
  const raw = fromMeta !== undefined && fromMeta !== null ? fromMeta : fromArg;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || !MCP_OPERATION_ID_PATTERN.test(raw)) {
    // Refuse loudly. Silently minting a fresh key for a malformed id would
    // hand back exactly the double-execution hazard the id exists to close,
    // while the client believed it was protected.
    return {
      ok: false,
      error: {
        code: "E_INVARG",
        message: "operation_id must be 1-128 characters of A-Z a-z 0-9 . _ - :",
        detail: {
          field: MCP_OPERATION_ID_ARG,
          reason: "invalid_operation_id",
          carrier: fromMeta !== undefined && fromMeta !== null ? MCP_OPERATION_ID_META : MCP_OPERATION_ID_ARG
        }
      }
    };
  }
  return { ok: true, value: raw };
}

/**
 * The `operation_id` property advertised on a tool's input schema.
 *
 * `pattern` is `MCP_OPERATION_ID_PATTERN.source` — the enforced regex itself,
 * not a restatement of it — because this rule is load-bearing rather than
 * cosmetic: it is what keeps `mcp:<actor>:<operation_id>` injective in
 * (actor, operation id), and a published approximation that admitted one
 * character the enforced rule rejects would advertise a key shape the turn
 * layer cannot honour. Deriving it from the RegExp makes drift impossible.
 *
 * The type is nullable because the property is optional and `null` is
 * accepted as "no id" (mcpOperationId). The bound `{1,128}` lives inside the
 * pattern, so no separate length facet is published.
 */
const MCP_OPERATION_ID_SCHEMA = {
  type: ["string", "null"],
  pattern: MCP_OPERATION_ID_PATTERN.source,
  description:
    "Optional client-chosen id for THIS operation. Reuse the exact same value when you retry after a lost or "
    + "ambiguous response: the retry is then deduplicated and returns the original outcome instead of running the "
    + "call a second time. Use a fresh value for a genuinely new operation. Strongly recommended for anything that "
    + "changes the world. Allowed characters are letters, digits, and . _ - : (1-128 of them)."
} as const;

/**
 * The presentation scope, defaulting when the caller supplied none.
 *
 * Absent and `null` both mean "not supplied" — `null` because every optional
 * parameter is advertised nullable (§M4.3). Any other value has already been
 * checked against the published `enum` by the time this runs, so the throw is
 * a residual internal guard rather than the client-facing refusal; the empty
 * string used to be defaulted here and is now refused by the enum, which is
 * the honest answer since the advertisement never listed it.
 */
function mcpToolScope(value: unknown): NetMcpToolScope {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "here" || value === "object" || value === "space") return value;
  throw new Error("scope must be one of active, here, object, space");
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

/** Placelessness is spelled two ways — an absent/empty value and the
 * `$nowhere` sentinel — and both mean "this session has no active space". */
function mcpPlacedScope(location: string): string | null {
  return location && location !== "$nowhere" ? location : null;
}

/**
 * The key a parked request is registered and cancelled under.
 *
 * JSON-RPC 2.0 ids are `String | Number` and the two are DISTINCT ids: `1`
 * and `"1"` name different requests, and a client is free to have both in
 * flight. Keying both sides by `String(id)` collapsed them, so a
 * `notifications/cancelled` for `"1"` released — without draining — a
 * `woo_wait` parked under `1`, silently returning an empty reply to a request
 * its client never cancelled. Discriminating on class keeps them apart.
 */
function mcpRequestKey(id: number | string): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

/** The `arguments` envelope must be a JSON object — not an array, and not
 * `null`. Arrays are objects to `typeof`, which is exactly how a positional
 * list used to pass for a property bag. */
function isMcpArgumentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpSanitizeId(value: string): string {
  return value.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Resolve a caller's word against a target's dispatchable pages, by the same
 * rule the world dispatcher uses.
 *
 * Aliases are PATTERNS — `l@ook`, `@exam*ine`, `get*`, `a|b` — not literals.
 * The gateway used to exact-compare `aliases.includes(verb)`, so `woo_call`
 * answered E_VERBNF for names `world.resolveVerb` accepts.
 *
 * Precedence matters as much as matching, and the dispatcher's order is a
 * TOTAL order with two levels. Reproducing only one of them is not enough:
 *
 *   1. chain order across definers — `resolveVerbFrom` walks the parent chain
 *      and stops at the first definer that answers. Flattening this into one
 *      global exact pass and then one global alias pass dispatches an
 *      ancestor's exactly-named verb where the world runs a nearer class's
 *      aliased one.
 *   2. SLOT order within one definer — `ownVerbNamed` scans `obj.verbs`, the
 *      slot array, exact names first and then alias patterns, taking the
 *      first hit of each scan. Ordering a definer's pages alphabetically
 *      instead means two verbs with overlapping alias patterns (slot 1
 *      `z_first` and slot 2 `a_second`, both aliased `x*`) resolve `x` to
 *      `a_second` here and `z_first` in the world.
 *
 * Both levels select a DIFFERENT verb, not a refusal, so getting either wrong
 * silently runs code the caller did not ask for. `drafts` therefore arrives in
 * chain order, contiguous per definer, slot-ordered within each — walking it
 * as-is is the dispatcher's walk.
 *
 * Fail-closed on unknown order. Order is only decidable when the tied
 * candidates carry DISTINCT, KNOWN slots, and neither half of that is
 * guaranteed:
 *
 *   - a page whose view record has no `slot` has no position at all; and
 *   - verbs authored over Net currently all land on `slot: 1`, because the
 *     sparse planning world materializes only the page being written, so the
 *     append lands in an empty verb array every time. Two such pages are not
 *     merely unordered here — the authoritative object reconstructed from
 *     those cells has no defined order either, so there is no right answer to
 *     pick.
 *
 * So a multi-candidate tie without distinct known slots is refused rather than
 * guessed. Silently falling back to alphabetical would be the very bug above,
 * dressed up as an answer. A single candidate needs no order and resolves
 * normally, which is every ordinary call.
 */
type McpVerbMatch =
  | { tool: NetMcpToolDraft }
  | { ambiguous: NetMcpToolDraft[] }
  | { miss: true };

function mcpMatchVerb(drafts: NetMcpToolDraft[], name: string): McpVerbMatch {
  for (let index = 0; index < drafts.length; ) {
    const definer = drafts[index].definer;
    let end = index;
    while (end < drafts.length && drafts[end].definer === definer) end += 1;
    const group = drafts.slice(index, end);
    // Exact names first, in slot order. The world's own installer refuses a
    // duplicate name on one object, so this scan cannot tie — but it is
    // ordered anyway, because the ordering is the rule, not an optimization.
    const exact = group.find((draft) => draft.verb === name);
    if (exact) return { tool: exact };
    const aliased = group.filter((draft) => draft.aliases.some((alias) => verbAliasMatches(alias, name)));
    if (aliased.length === 1) return { tool: aliased[0] };
    if (aliased.length > 1) {
      const slots = aliased.map((draft) => draft.slot);
      const orderable = slots.every((slot) => slot !== null) && new Set(slots).size === slots.length;
      // `aliased` preserves the group's slot ordering, so the head IS the
      // lowest slot once the order is known to be real.
      return orderable ? { tool: aliased[0] } : { ambiguous: aliased };
    }
    index = end;
  }
  return { miss: true };
}

/** Definition order for a verb page as the net view carries it. Verb cells are
 * the serialized VerbDef minus line_map, so `slot` rides along; `null` records
 * an aged or hand-built page that predates it rather than inventing a position. */
function mcpVerbSlot(value: unknown): number | null {
  const slot = (value as { slot?: unknown } | null)?.slot;
  return typeof slot === "number" && Number.isFinite(slot) ? slot : null;
}

/**
 * The verb doc-comment is the only prose an MCP client ever sees about a
 * world verb, so take the first PARAGRAPH — not the first physical line.
 *
 * The line-comment branch used to return a single `//` line, which cut the
 * seeded natives mid-sentence on the live surface ("Creates an object owned
 * by the invoking actor. There is intentionally no", "…so the destination's"):
 * doc-comments in the catalogs are written as wrapped `//` runs, so the first
 * line is almost never a complete thought. A run ends at the first line that
 * is not a `//` comment, or at a bare `//` (the author's paragraph break).
 *
 * Whichever style comes FIRST in the source wins. Preferring block comments
 * unconditionally meant a verb documented with leading slash-slash lines
 * advertised whatever bracketed comment it happened to contain later. A
 * bundled builder command verb described itself with a one-line caveat from a
 * `try` recovery some 3,000 characters below its actual documentation; the
 * end-to-end pin for it is in tests/worker/net-mcp-legibility.test.ts.
 *
 * Exported for tests: the clamp boundary is not reachable through the seeded
 * catalogs, and a truncation defect on this path is invisible until an agent
 * reads a sentence that stops mid-word.
 */
export function mcpFirstParagraph(source: string): string {
  const block = /\/\*([\s\S]*?)\*\//.exec(source);
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s*\/\//.test(line));
  // Character offset of that first line-initial `//`, so the two styles are
  // comparable by POSITION rather than by an arbitrary preference. (`+ 1`
  // restores the newline each split removed.)
  const lineOffset = start < 0
    ? -1
    : lines.slice(0, start).reduce((total, line) => total + line.length + 1, 0);
  if (start >= 0 && (!block || lineOffset < block.index)) {
    const paragraph: string[] = [];
    for (let index = start; index < lines.length; index += 1) {
      const match = /^\s*\/\/\s?(.*)$/.exec(lines[index]);
      if (!match) break; // the contiguous comment run ended
      const text = match[1].trim();
      if (!text) break; // a bare `//` is the author's paragraph break
      paragraph.push(text);
    }
    return mcpClampDescription(paragraph.join(" "));
  }
  if (block) {
    // Strip the `*` gutter BEFORE splitting: a JSDoc paragraph break is a
    // line holding only ` * `, which is not blank until the gutter is gone.
    const body = block[1].replace(/^\s*\*?[ \t]?/gm, "");
    return mcpClampDescription(body.split(/\n[ \t]*\n/)[0].trim());
  }
  return "";
}

/** A tool description is model context: an unbounded doc paragraph is a
 * context tax on every tools/list, and a hard cut mid-word reads as
 * corruption. Clamp on a word boundary with an explicit ellipsis. */
function mcpClampDescription(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MCP_DESCRIPTION_CAP) return collapsed;
  const cut = collapsed.slice(0, MCP_DESCRIPTION_CAP);
  const boundary = cut.lastIndexOf(" ");
  // Only honour the word boundary when it is not absurdly early (a single
  // 500-character "word" is pathological; a hard cut is better than nothing).
  const kept = boundary > MCP_DESCRIPTION_CAP * 0.6 ? cut.slice(0, boundary) : cut;
  return `${kept.replace(/[\s.,;:—-]+$/, "")}…`;
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
    const declared = explicitHint
      ? mcpSchemaForHint(explicitHint)
      : mcpSchemaForCommandSource(argumentSources[index]);
    // An optional parameter is advertised as nullable, because it genuinely
    // accepts `null` — that is what an absent property becomes on the way to
    // the verb (mcpNamedArgs). Publishing it keeps the advertised set and the
    // accepted set equal instead of leaving the leniency undeclared.
    properties[name] = optional ? mcpNullableSchema(declared) : declared;
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

/**
 * Argument validation for `tools/call` (mcp.md §M4.3).
 *
 * We advertise an `inputSchema` for every tool and, until this landed,
 * checked nothing against it: a missing property silently became `null` and a
 * wrong-typed one reached verb dispatch unchanged, so the schema a model
 * reads was decorative. Everything below runs BEFORE the turn is planned —
 * a refused call emits no observation and writes no cell.
 *
 * This is deliberately NOT a JSON Schema engine. It implements exactly the
 * vocabulary our own advertisements can contain — `type`, `enum`, `anyOf`,
 * and `required` — which covers everything `mcpInputSchema` derives from an
 * `arg_spec` (type hints, `command.args_from` shapes) plus the hand-written
 * stable-control schemas. Deliberately NOT supported, because no
 * advertisement can express them: nested object/array element schemas
 * (`items` is always `{}`), `additionalProperties`, `format`, numeric or
 * length bounds, `pattern`, `oneOf`/`allOf`/`not`, and schema references. A
 * schema fragment this validator does not understand constrains NOTHING rather than
 * refusing, so a richer future advertisement can never start rejecting calls
 * that were valid before the validator learned about it.
 */
type McpArgRefusal = { code: string; message: string; detail: Record<string, unknown> };

/** Which constraint a value failed. Distinguished so the refusal can name the
 * rule that was broken rather than reporting every failure as a type error. */
type McpSchemaViolation =
  | { kind: "type" }
  | { kind: "pattern"; pattern: string }
  | { kind: "min_length"; minLength: number };

/** The declared JSON type names, accepting both the single-name and the union
 * form. We emit the union form for every optional parameter (see
 * `mcpNullableSchema`), so the union case is ours, not merely tolerated. */
function mcpDeclaredTypes(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof schema.type === "string" && schema.type ? [schema.type] : [];
}

function mcpTypeAccepts(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    // JSON has one number type; `integer` is the narrower assertion. Both
    // reject the non-finite values JSON cannot carry anyway.
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    // An unrecognized type keyword constrains nothing — the fail-open rule.
    default: return true;
  }
}

/** Compiled `pattern` sources. Patterns come only from our own hand-written
 * advertisements (never from catalog `arg_spec`), so this is a fixed, small
 * set and cannot be grown by a client. */
const MCP_PATTERN_CACHE = new Map<string, RegExp>();
function mcpCompiledPattern(source: string): RegExp | null {
  const cached = MCP_PATTERN_CACHE.get(source);
  if (cached) return cached;
  try {
    const compiled = new RegExp(source);
    MCP_PATTERN_CACHE.set(source, compiled);
    return compiled;
  } catch {
    // An unusable pattern constrains nothing rather than refusing everything.
    return null;
  }
}

/** `null` when `value` satisfies the shallow schema fragment, else which
 * constraint it broke. An empty or unrecognized fragment accepts everything —
 * see the fail-open rule above. */
function mcpSchemaViolation(schema: Record<string, unknown>, value: unknown): McpSchemaViolation | null {
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (mcpSchemaViolation(mcpRecord(branch), value) === null) return null;
    }
    return { kind: "type" };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    return { kind: "type" };
  }
  const declared = mcpDeclaredTypes(schema);
  if (declared.length > 0 && !declared.some((entry) => mcpTypeAccepts(entry, value))) {
    return { kind: "type" };
  }
  // String facets apply only to strings: JSON Schema treats a facet as
  // vacuously satisfied by a value of any other type, and the union types we
  // publish for optional parameters depend on that (`null` must not have to
  // satisfy `minLength`).
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return { kind: "min_length", minLength: schema.minLength };
    }
    if (typeof schema.pattern === "string") {
      const compiled = mcpCompiledPattern(schema.pattern);
      if (compiled && !compiled.test(value)) return { kind: "pattern", pattern: schema.pattern };
    }
  }
  return null;
}

/** What a refusal should say the parameter had to be. */
function mcpSchemaExpectation(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf
      .map((branch) => mcpSchemaExpectation(mcpRecord(branch)))
      .filter((text) => text !== "any");
    if (branches.length > 0) return branches.join(" or ");
    return "any";
  }
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  const declared = mcpDeclaredTypes(schema);
  if (declared.length > 0) return declared.join(" or ");
  return "any";
}

/**
 * The published schema for an OPTIONAL parameter: the declared schema widened
 * to admit `null`.
 *
 * Optional means "omit it, or send null" — the transport itself substitutes
 * `null` for an absent property when mapping named arguments onto positional
 * ones (§M2.2), and LLM clients routinely spell an unset optional as an
 * explicit `null`. That acceptance used to live as a carve-out inside the
 * validator, which made the accepted set WIDER than the advertised one. The
 * widening now happens in the schema instead, so the advertisement states it
 * and the validator needs no special case.
 *
 * Idempotent: re-widening an already-nullable schema is a no-op.
 */
function mcpNullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((branch) => mcpDeclaredTypes(mcpRecord(branch)).includes("null"))) return schema;
    return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  }
  const out: Record<string, unknown> = { ...schema };
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => value === null)) {
    out.enum = [...schema.enum, null];
  }
  const declared = mcpDeclaredTypes(schema);
  // An unconstrained fragment already admits null; a union that names it is
  // already done.
  if (declared.length === 0 || declared.includes("null")) return out;
  out.type = [...declared, "null"];
  return out;
}

/** The JSON type name to report back for a rejected value. */
function mcpJsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * Validate a named-argument object against the schema that was advertised
 * for it. Used for the stable controls (schema straight out of
 * `MCP_TOOL_DEFS`) and for dynamic `<object>__<verb>` tools (schema straight
 * out of `mcpProtocolTool`), so the validator and the advertisement are the
 * same object and cannot drift.
 *
 * STRICTNESS: required-presence and type agreement are enforced; **unknown
 * properties are ignored, not rejected.** Our advertised schemas do not set
 * `additionalProperties: false`, so JSON Schema's own reading of them permits
 * extras — rejecting what we advertise as permitted would be a fresh
 * disagreement, and real MCP clients do decorate `arguments`. The failure
 * mode that matters, a misspelled parameter name, is still caught: the
 * correctly spelled parameter is then missing, and the refusal lists the
 * unrecognized properties so the typo is diagnosable.
 */
function mcpValidateNamedArguments(
  tool: string,
  schema: Record<string, unknown>,
  values: Record<string, unknown>
): McpArgRefusal | null {
  const properties = mcpRecord(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  // `undefined` is not a JSON value, but a hand-built client object can carry
  // it; treat it as absent rather than as a value that fails every type.
  const supplied = (name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) && values[name] !== undefined;
  const missing = required.filter((name) => !supplied(name));
  if (missing.length > 0) {
    const field = missing[0];
    const expected = mcpSchemaExpectation(mcpRecord(properties[field]));
    // Only computed on the refusal path: an accepted call must not pay for it.
    const unknown = Object.keys(values).filter((name) => !(name in properties));
    return {
      code: "E_INVARG",
      message: `${tool}: missing required argument "${field}" (${expected})`,
      detail: {
        reason: "missing_required_argument",
        tool,
        field,
        missing,
        expected,
        required,
        ...(unknown.length > 0 ? { unknown_properties: unknown } : {}),
        remediation: unknown.length > 0
          ? `supply "${field}" as ${expected}; these supplied properties are not parameters of this tool and were ignored: `
            + `${unknown.map((name) => `"${name}"`).join(", ")} — check for a misspelling`
          : `supply "${field}" as ${expected}; this tool requires ${required.map((name) => `"${name}"`).join(", ")}`
      }
    };
  }
  // Advertisement order, not client order: the refusal a client sees for a
  // given bad payload must not depend on JSON key ordering.
  for (const [name, declared] of Object.entries(properties)) {
    if (!supplied(name)) continue;
    const value = values[name];
    const declaredSchema = mcpRecord(declared);
    const violation = mcpSchemaViolation(declaredSchema, value);
    if (!violation) continue;
    const terms = mcpViolationTerms(violation, declaredSchema, value);
    return {
      code: "E_INVARG",
      message: `${tool}: ${terms.message(`argument "${name}"`)}`,
      detail: {
        reason: terms.reason,
        tool,
        field: name,
        expected: terms.expected,
        ...terms.detail,
        remediation: `pass "${name}" as ${terms.expected}`
      }
    };
  }
  return null;
}

/**
 * How one broken constraint is reported: its `detail.reason`, a human phrase
 * for what was required, the message tail, and any constraint-specific detail
 * fields. Shared by the named and positional validators so a `pattern`
 * failure reads the same through either door.
 */
function mcpViolationTerms(
  violation: McpSchemaViolation,
  schema: Record<string, unknown>,
  value: unknown
): { reason: string; expected: string; message: (subject: string) => string; detail: Record<string, unknown> } {
  if (violation.kind === "pattern") {
    const expected = `a string matching ${violation.pattern}`;
    return {
      reason: "argument_pattern_mismatch",
      expected,
      message: (subject) => `${subject} does not match the required format ${violation.pattern}`,
      detail: { pattern: violation.pattern }
    };
  }
  if (violation.kind === "min_length") {
    const expected = violation.minLength === 1
      ? "a non-empty string"
      : `a string of at least ${violation.minLength} characters`;
    return {
      reason: "argument_too_short",
      expected,
      message: (subject) => `${subject} must be ${expected}`,
      detail: { min_length: violation.minLength, received_length: String(value).length }
    };
  }
  const expected = mcpSchemaExpectation(schema);
  return {
    reason: "argument_type_mismatch",
    expected,
    message: (subject) => `${subject} must be ${expected}, received ${mcpJsonTypeOf(value)}`,
    detail: { received: mcpJsonTypeOf(value) }
  };
}

/**
 * Validate `woo_call`'s positional `args` list against the resolved verb's
 * own `arg_spec` — the same input `mcpInputSchema` turns into the advertised
 * `inputSchema`, so a verb that is also advertised is checked identically
 * through both doors.
 *
 * RESIDUAL, stated in mcp.md §M4.3: a page whose `arg_spec` carries no
 * declaration list at all declares no arity this gateway could check. That is
 * the `(dobj, prep, iobj)` command-header form, whose parameters are bound
 * from parsed command tokens rather than declared positionally, and any aged
 * page written before `arg_spec` carried one. Those calls pass through
 * unexamined; the alternative — assuming zero parameters — would refuse every
 * legitimate command-shaped call.
 */
function mcpValidatePositionalArguments(
  object: string,
  verb: string,
  argSpec: Record<string, unknown>,
  values: unknown[]
): McpArgRefusal | null {
  if (!Array.isArray(argSpec.args) && !Array.isArray(argSpec.params)) return null;
  const derived = mcpInputSchema(argSpec);
  const properties = mcpRecord(derived.schema.properties);
  const required = Array.isArray(derived.schema.required)
    ? (derived.schema.required as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const requiredSet = new Set(required);
  const target = `${object}:${verb}`;
  // Optional markers are not guaranteed to be trailing (`["a?", "b"]` is
  // expressible), so the minimum arity is one past the LAST required
  // position, not the count of required names.
  let minimum = 0;
  derived.args.forEach((name, index) => {
    if (requiredSet.has(name)) minimum = index + 1;
  });
  if (values.length < minimum) {
    const field = derived.args[values.length] ?? derived.args[derived.args.length - 1] ?? "";
    const expected = mcpSchemaExpectation(mcpRecord(properties[field]));
    return {
      code: "E_INVARG",
      message:
        `${target}: missing required argument #${values.length + 1} "${field}" (${expected}) — `
        + `the verb takes at least ${minimum} argument${minimum === 1 ? "" : "s"}, received ${values.length}`,
      detail: {
        reason: "missing_required_argument",
        obj: object,
        name: verb,
        field,
        position: values.length,
        expected,
        declared: derived.args,
        minimum_arity: minimum,
        received_arity: values.length,
        remediation: `pass args in the declared order (${derived.args.join(", ")})`
      }
    };
  }
  if (values.length > derived.args.length) {
    return {
      code: "E_INVARG",
      message:
        `${target}: too many arguments — the verb declares ${derived.args.length} `
        + `(${derived.args.join(", ") || "none"}), received ${values.length}`,
      detail: {
        reason: "too_many_arguments",
        obj: object,
        name: verb,
        declared: derived.args,
        maximum_arity: derived.args.length,
        received_arity: values.length,
        remediation: derived.args.length > 0
          ? `pass at most ${derived.args.length} args, in the declared order (${derived.args.join(", ")})`
          : "this verb takes no arguments; pass an empty args list"
      }
    };
  }
  for (const [index, name] of derived.args.entries()) {
    if (index >= values.length) break;
    const value = values[index];
    // No `null` carve-out here either: an optional parameter's DERIVED schema
    // already admits null (mcpNullableSchema), so the check is uniform.
    const declaredSchema = mcpRecord(properties[name]);
    const violation = mcpSchemaViolation(declaredSchema, value);
    if (!violation) continue;
    const terms = mcpViolationTerms(violation, declaredSchema, value);
    return {
      code: "E_INVARG",
      message: `${target}: ${terms.message(`argument #${index + 1} "${name}"`)}`,
      detail: {
        reason: terms.reason,
        obj: object,
        name: verb,
        field: name,
        position: index,
        expected: terms.expected,
        ...terms.detail,
        declared: derived.args,
        remediation: `pass args[${index}] ("${name}") as ${terms.expected}`
      }
    };
  }
  return null;
}

/** Map the validated named-argument object onto the verb's positional list.
 * An absent OPTIONAL parameter becomes `null` here; an absent REQUIRED one
 * can no longer reach this point (mcpValidateNamedArguments refused it). */
function mcpNamedArgs(tool: NetMcpDynamicTool, values: Record<string, unknown>): unknown[] {
  return tool.argNames.map((name) => values[name] ?? null);
}

/**
 * The protocol view of a dynamic tool. The reserved `operation_id` property
 * is added here (never in the descriptor's own schema) so retry safety is
 * advertised on every dynamic tool without the resolver knowing about it —
 * and it is SKIPPED when the verb already declares a parameter of that name,
 * because that verb owns the name and the value must reach it unchanged.
 * Those tools still accept the id through `_meta` (see mcpOperationId).
 */
function mcpProtocolTool(tool: NetMcpDynamicTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  if (tool.argNames.includes(MCP_OPERATION_ID_ARG)) {
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }
  const properties = mcpRecord(tool.inputSchema.properties);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...properties, [MCP_OPERATION_ID_ARG]: MCP_OPERATION_ID_SCHEMA }
    }
  };
}

function mcpToolSummary(tool: NetMcpDynamicTool, includeSchema: boolean): Record<string, unknown> {
  return {
    name: tool.name,
    object: tool.object,
    verb: tool.verb,
    aliases: tool.aliases,
    args: tool.argNames,
    description: tool.description,
    // The PROTOCOL schema, so `woo_list_reachable_tools` and `tools/list`
    // advertise the same call surface — including the reserved
    // `operation_id`. Handing back the raw descriptor schema here would hide
    // retry safety from exactly the agents that discover tools this way.
    ...(includeSchema ? { input_schema: mcpProtocolTool(tool).inputSchema } : {})
  };
}

/** The tool set the walkthrough's client contract uses — an ENVELOPE
 * around the net client surface, never a second path.
 *
 * Written in CORE form: each property declares only its own constraints, and
 * optionality is expressed once, by omission from `required`. `MCP_TOOL_DEFS`
 * below is this run through `mcpControlSchema`, which widens every optional
 * property to admit `null` using the same helper `mcpInputSchema` applies to
 * optional verb parameters. Hand-writing the nullable unions here instead
 * would be six chances to describe optionality differently from the dynamic
 * door. */
const MCP_TOOL_DEFS_CORE = [
  {
    name: "woo_call",
    description:
      "Call any verb you can reach, as the session's actor. Works when your cached tool list is stale, and reaches verbs that are not advertised as tools. "
      + "The target must be reachable: yourself, the space you are in, that space's contents, or your inventory. "
      + "Refusals name the condition: unreachable target, undefined verb (E_VERBNF), or a permission gate.",
    inputSchema: {
      type: "object",
      properties: {
        // `minLength: 1` is advertised because it is ENFORCED: an empty id or
        // verb name resolves nowhere, and the gateway refused it long before
        // this schema said so. Publishing the bound is what lets a client
        // predict that refusal.
        object: { type: "string", minLength: 1, description: "Canonical object id. `$me` is the session actor; `$here` is the space you are in." },
        verb: { type: "string", minLength: 1, description: "Verb name or alias." },
        args: { type: "array", items: {}, description: "Positional arguments, in the verb's declared order." },
        operation_id: MCP_OPERATION_ID_SCHEMA
      },
      required: ["object", "verb"]
    }
  },
  {
    name: "woo_wait",
    description:
      "Long-poll the session's observation queue — this is how you hear what other actors do. "
      + "Returns {observations, gap}; `gap:true` means continuity could not be proven and some observations may have been lost, so re-orient (look/who) rather than assume you heard everything.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "number", description: "How long to park when the queue is empty; 0–25000, default 1000." },
        limit: { type: "number", description: "Maximum observations to drain; 1–256, default 64." }
      }
    }
  },
  {
    name: "woo_list_reachable_tools",
    description:
      "Page and filter the DYNAMIC tools in the session's structural context. `total` counts dynamic tools only, and excludes these woo_* protocol controls. "
      + "Note that standard tools/list returns at most 128 entries per page including the woo_* controls, so its first page and this total are not comparable.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["active", "here", "object", "space"],
          description: "Presentation only, never authority: active = you + your space + its contents + inventory (default); here = your space and its contents; object = one named contextual object; space = one contextual space and its contents."
        },
        object: { type: "string", description: "Target object for scope `object`/`space`." },
        query: { type: "string", description: "Case-insensitive match over name, object, verb, aliases, and description." },
        limit: { type: "number", description: "Page size; 1–256, default 64." },
        cursor: { type: "string", description: "Opaque cursor from a previous `next_cursor`." },
        include_schema: { type: "boolean", description: "Add each descriptor's `input_schema`." }
      }
    }
  }
] as const;

/** Widen a control's OPTIONAL properties to admit `null`, by the same rule
 * and the same helper the dynamic door uses for optional verb parameters. */
function mcpControlSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = mcpRecord(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : []
  );
  const widened: Record<string, unknown> = {};
  for (const [name, declared] of Object.entries(properties)) {
    widened[name] = required.has(name) ? declared : mcpNullableSchema(mcpRecord(declared));
  }
  return { ...schema, properties: widened };
}

/** The PUBLISHED stable-control descriptors — what `tools/list` returns. */
const MCP_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> =
  MCP_TOOL_DEFS_CORE.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: mcpControlSchema(definition.inputSchema as unknown as Record<string, unknown>)
  }));

/**
 * The advertised input schema of each stable control, keyed by tool name.
 *
 * Projected from `MCP_TOOL_DEFS` itself rather than restated, so the object
 * `tools/call` validates against IS the object `tools/list` published. A
 * second, hand-maintained copy would be a new drift surface — exactly the bug
 * this validation exists to close for dynamic tools.
 */
const MCP_CONTROL_SCHEMAS: Record<string, Record<string, unknown>> = Object.fromEntries(
  MCP_TOOL_DEFS.map((definition) => [definition.name, definition.inputSchema])
);
