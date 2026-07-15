/**
 * NetScopeDO — the Durable Object shell for a scope authority (Plan 002
 * Phase 3 step 2; coherence.md CO1 SCOPE role, CO5 copy #1).
 *
 * Thin by design: all sequencing/validation semantics live in
 * src/net/scope.ts (ScopeSequencer); this file provides only
 *   - SqliteScopeStore: the DO-SQLite binding of the step-1 ScopeStore
 *     interface (sync, one table per row family, transactionSync
 *     atomicity — the same sync-storage contract as ObjectRepository);
 *   - lazy hydration: the sequencer is built on the first request that
 *     needs it, entirely from the durable store (no partial hydration —
 *     scopes are room-sized, the fixed Phase-3 decision);
 *   - the internal-auth'd /net RPC surface (kickoff "RPC surface"):
 *       POST /net/submit    CommitSubmit → CommitReply. The HTTP body is
 *                           either a bare CommitSubmit or
 *                           {submit, rider_destinations} — the sibling
 *                           field is the gateway's CA3 rider directions
 *                           (src/net/scope.ts types stay unchanged; the
 *                           sequencer never learns rider topology)
 *       POST /net/attest    {keys} → {scope, catalog_epoch, owner_head, cells:
 *                           [{key, version}]} — the CO2.3 rider-read
 *                           attestation surface: the gateway fetches
 *                           this from each owner scope at plan time so
 *                           the committing scope can validate foreign
 *                           reads (absent cells attest "absent")
 *       POST /net/closure   {keys, known?} → lineage-closed CellTransfer
 *       GET  /net/probe     signed, state-free install-secret readiness
 *                           probe; deliberately answered before sequencer
 *                           hydration or pending-work drain
 *       GET  /net/head      {scope, catalog_epoch, head}
 *       POST /net/seed      bootstrap/install path (also how tests build
 *                           a scope; the catalog install pipeline adopts
 *                           it in a later step)
 *       POST /net/subscribe {destination, role?} → register a receiver.
 *                           role "fanout" (default) receives /net/fanout
 *                           deliveries (a gateway shard; maintained on
 *                           session open); role "planner" registers a
 *                           planner gateway for scheduled-turn execution
 *                           (CO16) — it receives /net/plan-scheduled,
 *                           never fanout
 *       POST /net/adopt     {from_scope, seq, cells, prior_versions?} →
 *                           CA3 rider adoption as an OWNER-SEQUENCED
 *                           commit (CO2.3): per-cell prior-version CAS,
 *                           head advances once per applied batch, and
 *                           the adopted cells fan out to this scope's
 *                           own subscribers; idempotent by (from_scope,
 *                           seq). The catalog owner terminally acknowledges
 *                           but never installs marked definition riders
 *                           (CO15's authority enforcement).
 *       POST /net/relate    {from_scope, seq, deltas} → CO13 relation
 *                           delivery: deltas derived at another scope
 *                           whose owner objects anchor here apply to
 *                           this scope's relation family (owner-
 *                           sequenced — the head advances once per
 *                           applied batch) and refan to this scope's
 *                           own subscribers; idempotent by (from_scope,
 *                           seq) — a separate high-water from /adopt
 *       POST /net/schedule  park a scheduled turn + arm the alarm
 *                           (test-facing until the gateway machinery
 *                           schedules from transcripts)
 *   - the durable fanout outbox (CO2.7): accepted commits enqueue
 *     /net/fanout rows (every subscriber), /net/adopt rows (every
 *     rider scope), and /net/relate rows (every foreign relation-owner
 *     scope) in the SAME transaction as the commit write-through,
 *     then drain via host.defer — never on the reply path; leftover rows
 *     drain on the next request (drain-on-reactivation);
 *   - the alarm() wake path (CO16): when a planner-role subscriber is
 *     registered, each due scheduled turn moves ATOMICALLY from the
 *     scheduled row family to a durable /plan-scheduled outbox row (one
 *     transaction — never lost, never duplicated) addressed to ONE
 *     planner, then drains like any outbox lane; with no planner the due
 *     turns stay parked with a named metric (the specified no-planner
 *     state). ALWAYS re-arm from durable state — the queue is scope
 *     state, so a parked task survives eviction (CO2.8).
 *
 * This class sits beside the v2 DO classes and shares nothing with them:
 * the standing v2 freeze continues, nothing routes production traffic
 * here until Phase 5.
 */
import type { Cell } from "../../net/cells";
import { cellKey, lineageClosureKeys, serializeTransfer, type CellTransfer } from "../../net/cells";
import { isNetError, netError } from "../../net/errors";
import { Outbox, type FanoutBody, type FanoutRow } from "../../net/outbox";
import { ScopeSequencer, type CommitSubmit, type ScheduledTurn, type ScopeHead } from "../../net/scope";
import { authorizeSessionSubmit, validateSessionCell } from "../../net/sessions";
import { observationsForRelationOwners, relationKey, roomRosterRows, type RelationDelta, type RelationRow } from "../../net/relations";
import { orderedChildrenVersion, orderedNeighborsFromRows } from "../../net/ordered-edges";
import type { ScopeMeta, ScopeStore, TailEntry } from "../../net/scope-store";
import type { CommitReply } from "../../net/scope";
import { netCellKeyFor } from "../../net/transcript";
import { CATALOG_SCOPE } from "../../net/topology";
import { verifyInternalRequest } from "../internal-auth";
import { emitMetric, type AnalyticsMetric } from "../metrics-sink";
import { resolveNetDestination, WorkerdHost, type NetBindingsEnv } from "./workerd-host";

/** The structural slice of DurableObjectState this DO uses. Matches the
 * CommitScopeDO idiom (structural, not workers-types-nominal) so the
 * fake-DO harness and real workerd both satisfy it. */
export type NetScopeDurableState = {
  id: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  storage: {
    sql: { exec(query: string, ...params: unknown[]): unknown };
    transactionSync<T>(callback: () => T): T;
    setAlarm(at: number): void | Promise<void>;
    deleteAlarm(): void | Promise<void>;
  };
};

export type NetScopeEnv = NetBindingsEnv;

/** The gateway's CA3 rider directions (submit HTTP-body sibling): per
 * rider scope, its rpc destination and the objects anchored to it. */
type RiderDestinations = Record<string, { destination: string; objects: string[] }>;

/** The gateway's CO13 relation-owner directions (submit HTTP-body
 * sibling, same principle as RiderDestinations: anchor topology is
 * gateway knowledge the sequencer never learns). Per FOREIGN owner
 * scope, its rpc destination and the relation-owner OBJECTS (move
 * sources/destinations, create locations, transition rooms) anchored to
 * it. The shell turns this into the sequencer's `scopeOf` hints, so the
 * accept-path delta partition and the /relate row destinations agree by
 * construction. Absent (direct submits, tests) → every delta is local. */
type RelateDestinations = Record<string, { destination: string; objects: string[] }>;

/** The four outbox delivery surfaces. They drain as separate lanes so a
 * destination carrying several cannot collide row ids, and adoption/
 * relation/planner delivery cannot be held behind a slow subscriber (or
 * vice versa). */
type OutboxRoute = "/fanout" | "/adopt" | "/relate" | "/plan-scheduled";

/** Subscriber roles (CO16): `fanout` receives /net/fanout deliveries;
 * `planner` registers a planner gateway that executes scheduled turns
 * via /net/plan-scheduled. One destination may hold both roles. */
type SubscriberRole = "fanout" | "planner";

/** The /adopt outbox body: FanoutBody plus the per-cell prior versions
 * the committing turn observed (the rider-read integrity interim guard —
 * notes/2026-07-06-rider-read-integrity.md). Extra field only; the
 * src/net/outbox.ts FanoutBody type stays unchanged (Outbox carries the
 * body opaquely and the JSON round-trip through net_scope_outbox keeps
 * the field). */
type AdoptOutboxBody = FanoutBody & { prior_versions?: Record<string, string> };

/** The /plan-scheduled outbox body (CO16): FanoutBody plus the scheduled
 * turn and the epoch the planner must plan under. `seq` is NOT a scope
 * head seq — scheduled dispatch does not advance the head — but the
 * durable dispatch counter (net_scope_sched_dispatch), which keeps the
 * outbox row id unique per turn and the planner lane's drain order equal
 * to dispatch order. Same extra-field-only principle as AdoptOutboxBody:
 * the src/net/outbox.ts FanoutBody type stays unchanged. */
type PlanScheduledOutboxBody = FanoutBody & { scheduled_turn: ScheduledTurn; catalog_epoch: string };

/** Rows out of a storage.sql cursor (both the real SqlStorageCursor and
 * the fake expose toArray()). */
function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

/**
 * DO-SQLite ScopeStore: five row families, five tables, JSON bodies.
 * Everything is synchronous (the DO SQLite API is sync); `transaction`
 * wraps storage.transactionSync and joins an already-open transaction on
 * nested calls, per the ScopeStore contract.
 */
export class SqliteScopeStore implements ScopeStore {
  private transactionDepth = 0;

  constructor(private readonly storage: NetScopeDurableState["storage"]) {
    // CREATE IF NOT EXISTS on every construction — the established DO
    // idiom (CommitScopeDO does the same): cheap, idempotent, and no
    // separate "first boot" path to get wrong.
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    // Phase 5 durable-format stamp: ONE branch point for all future
    // durable evolution (and the migration ledger's anchor row). Written
    // at construction — INSERT OR IGNORE, so an existing world keeps the
    // version it was created at and future readers can branch on it
    // instead of probing table shapes.
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO net_scope_meta (id, body) VALUES ('schema_version', ?)",
      JSON.stringify({ v: 1 })
    );
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_reply (idempotency_key TEXT PRIMARY KEY, body TEXT NOT NULL)"
    );
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_tail (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    // `due_at` mirrors the body's at_logical_time so due-time questions
    // (next future wake, due-burst batching) are one indexed lookup, never
    // a read-and-parse of every parked row (ready-to-scale Phase 3). It
    // must exist BEFORE any namespace holds data (cf-do-0004 freeze);
    // the probe+ALTER covers pre-column dev worlds, and the backfill is
    // idempotent (only NULL rows, so a crash between ALTER and backfill
    // heals on the next construction).
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_scheduled (id TEXT PRIMARY KEY, body TEXT NOT NULL, due_at INTEGER)"
    );
    const scheduledColumns = sqlRows<{ name: string }>(this.storage.sql.exec("PRAGMA table_info(net_scope_scheduled)"));
    if (!scheduledColumns.some((column) => column.name === "due_at")) {
      this.storage.sql.exec("ALTER TABLE net_scope_scheduled ADD COLUMN due_at INTEGER");
    }
    // One-time backfill, gated by a meta marker (review: an unconditional
    // WHERE-IS-NULL scan is O(parked rows) on EVERY cold construction —
    // exactly the cold-DO scale class Phase 3 removes). A crash between
    // backfill and marker heals on the next construction (idempotent).
    if (!this.metaMarkerPresent("migrated_scheduled_due_at")) {
      for (const row of sqlRows<{ id: string; body: string }>(
        this.storage.sql.exec("SELECT id, body FROM net_scope_scheduled WHERE due_at IS NULL")
      )) {
        const turn = JSON.parse(row.body) as ScheduledTurn;
        this.storage.sql.exec("UPDATE net_scope_scheduled SET due_at = ? WHERE id = ?", turn.at_logical_time, row.id);
      }
      this.writeMetaMarker("migrated_scheduled_due_at");
    }
    this.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_net_scope_scheduled_due ON net_scope_scheduled (due_at)");
    // Sixth row family (CO13): derived relation rows this scope owns.
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_relation (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }

  transaction<T>(fn: () => T): T {
    // Nested calls join the outer transaction (real workerd
    // transactionSync does not nest; the depth guard keeps the contract).
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth = 1;
    try {
      return this.storage.transactionSync(fn);
    } finally {
      this.transactionDepth = 0;
    }
  }

  /** Migration-marker rows in net_scope_meta (Phase 5's schema_version
   * discipline applied to one-time backfills): a marker present means the
   * named backfill already ran, so cold constructions never re-scan. */
  metaMarkerPresent(id: string): boolean {
    const rows = sqlRows<{ n: number }>(
      this.storage.sql.exec("SELECT EXISTS(SELECT 1 FROM net_scope_meta WHERE id = ?) AS n", id)
    );
    return rows.length > 0 && Number(rows[0].n) > 0;
  }

  writeMetaMarker(id: string): void {
    this.storage.sql.exec("INSERT OR IGNORE INTO net_scope_meta (id, body) VALUES (?, ?)", id, JSON.stringify({ v: 1 }));
  }

  readMeta(): ScopeMeta | null {
    const rows = sqlRows<{ body: string }>(this.storage.sql.exec("SELECT body FROM net_scope_meta WHERE id = 'meta'"));
    return rows.length > 0 ? (JSON.parse(rows[0].body) as ScopeMeta) : null;
  }

  writeMeta(meta: ScopeMeta): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_meta (id, body) VALUES ('meta', ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      JSON.stringify(meta)
    );
  }

  readCells(): Cell[] {
    return sqlRows<{ body: string }>(this.storage.sql.exec("SELECT body FROM net_scope_cell")).map(
      (row) => JSON.parse(row.body) as Cell
    );
  }

  writeCell(cell: Cell): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_cell (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
      cell.key,
      JSON.stringify(cell)
    );
  }

  deleteCell(key: string): void {
    this.storage.sql.exec("DELETE FROM net_scope_cell WHERE key = ?", key);
  }

  readReplies(): Array<{ key: string; reply: CommitReply }> {
    return sqlRows<{ idempotency_key: string; body: string }>(
      this.storage.sql.exec("SELECT idempotency_key, body FROM net_scope_reply")
    ).map((row) => ({ key: row.idempotency_key, reply: JSON.parse(row.body) as CommitReply }));
  }

  writeReply(key: string, reply: CommitReply): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_reply (idempotency_key, body) VALUES (?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET body = excluded.body",
      key,
      JSON.stringify(reply)
    );
  }

  deleteReply(key: string): void {
    this.storage.sql.exec("DELETE FROM net_scope_reply WHERE idempotency_key = ?", key);
  }

  readTail(): TailEntry[] {
    return sqlRows<{ body: string }>(this.storage.sql.exec("SELECT body FROM net_scope_tail ORDER BY seq ASC")).map(
      (row) => JSON.parse(row.body) as TailEntry
    );
  }

  appendTail(entry: TailEntry): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_tail (seq, body) VALUES (?, ?) ON CONFLICT(seq) DO UPDATE SET body = excluded.body",
      entry.seq,
      JSON.stringify(entry)
    );
  }

  trimTail(limit: number): void {
    // Keep the newest `limit` rows — the CO5 bounded recovery log.
    this.storage.sql.exec(
      "DELETE FROM net_scope_tail WHERE seq NOT IN (SELECT seq FROM net_scope_tail ORDER BY seq DESC LIMIT ?)",
      limit
    );
  }

  readScheduled(): ScheduledTurn[] {
    return sqlRows<{ body: string }>(this.storage.sql.exec("SELECT body FROM net_scope_scheduled")).map(
      (row) => JSON.parse(row.body) as ScheduledTurn
    );
  }

  writeScheduled(turn: ScheduledTurn): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_scheduled (id, body, due_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, due_at = excluded.due_at",
      turn.id,
      JSON.stringify(turn),
      turn.at_logical_time
    );
  }

  deleteScheduled(id: string): void {
    this.storage.sql.exec("DELETE FROM net_scope_scheduled WHERE id = ?", id);
  }

  /** Phase 3 bounded due queries — all answered off the due_at index so
   * the alarm path's work is O(due batch), never O(parked rows). */
  readScheduledDue(now: number, limit: number): ScheduledTurn[] {
    return sqlRows<{ body: string }>(
      this.storage.sql.exec(
        "SELECT body FROM net_scope_scheduled WHERE due_at <= ? ORDER BY due_at, id LIMIT ?",
        now,
        limit
      )
    ).map((row) => JSON.parse(row.body) as ScheduledTurn);
  }

  /** Earliest scheduled due-time strictly after `now`, or null — one
   * indexed MIN lookup (alarm re-arming must not read and parse every
   * parked row; overdue parked rows are deliberately excluded so the
   * no-planner state cannot spin the alarm). */
  nextScheduledAfter(now: number): number | null {
    const rows = sqlRows<{ at: number | null }>(
      this.storage.sql.exec("SELECT MIN(due_at) AS at FROM net_scope_scheduled WHERE due_at > ?", now)
    );
    return rows.length > 0 && rows[0].at !== null ? Number(rows[0].at) : null;
  }

  hasScheduledDue(now: number): boolean {
    const rows = sqlRows<{ n: number }>(
      this.storage.sql.exec("SELECT EXISTS(SELECT 1 FROM net_scope_scheduled WHERE due_at <= ?) AS n", now)
    );
    return rows.length > 0 && Number(rows[0].n) > 0;
  }

  hasScheduled(id: string): boolean {
    const rows = sqlRows<{ n: number }>(
      this.storage.sql.exec("SELECT EXISTS(SELECT 1 FROM net_scope_scheduled WHERE id = ?) AS n", id)
    );
    return rows.length > 0 && Number(rows[0].n) > 0;
  }

  readRelations(): RelationRow[] {
    return sqlRows<{ body: string }>(this.storage.sql.exec("SELECT body FROM net_scope_relation")).map(
      (row) => JSON.parse(row.body) as RelationRow
    );
  }

  writeRelation(key: string, row: RelationRow): void {
    this.storage.sql.exec(
      "INSERT INTO net_scope_relation (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
      key,
      JSON.stringify(row)
    );
  }

  deleteRelation(key: string): void {
    this.storage.sql.exec("DELETE FROM net_scope_relation WHERE key = ?", key);
  }
}

const SCOPE_ALARM_KEY = "scope";
const OUTBOX_ALARM_KEY = "outbox";
/** H2b: the session-reaper wake (a third key into the single storage
 * alarm — WorkerdHost keeps the earliest across keys). */
const SESSION_ALARM_KEY = "session-reap";

/** Mirror of src/net/outbox.ts's default backoff, passed INTO the Outbox
 * at drain time so the drain's skip-window and the alarm's retry-time
 * computation (outboxNextRetryAt) can never drift apart. */
const OUTBOX_BACKOFF_MS = (attempt: number): number => Math.min(30_000, 250 * 2 ** (attempt - 1));

/** The outbox's route lanes, in drain order (matches OutboxRoute). */
const OUTBOX_ROUTES = ["/fanout", "/adopt", "/relate", "/plan-scheduled"] as const;

/** Phase-3 drain bounds: one pass touches at most LANES_PER_PASS due
 * destinations per route and ROWS_PER_LANE rows per destination (a lane
 * PREFIX in (scope, seq) order — CO2.7 ordering is untouched). Remaining
 * healthy work continues through an immediate alarm; failed rows wait for
 * their due-time alarm. The small per-lane quantum is intentional: a hot
 * authority must yield between fanout slices so submit service is not
 * trapped behind a long chain of otherwise healthy delivery RPCs.
 *
 * DECIDED (review #4): lane ENUMERATION per pass is O(active lanes) —
 * the directory is read whole and each lane head-probed until enough due
 * lanes are found. Intentional: active lanes are this scope's real
 * fan-out (its fanout subscribers plus the neighbor scopes its commits
 * ride to), a Big-World-safe quantity that never grows with backlog
 * depth or world size — bounding it further would need a due-ordered
 * lane index maintained on every head change, complexity the fan-out
 * numbers do not justify. LANES_PER_PASS bounds the DELIVERY fan-out of
 * one pass, not the enumeration. */
const OUTBOX_LANES_PER_PASS = 16;
const OUTBOX_ROWS_PER_LANE = 4;
/** Passes one drain INVOCATION may run before yielding to the alarm
 * continuation (review #2): bounds a single waitUntil task's total CPU
 * under a catch-up backlog at LANES×ROWS×PASSES rows; the retry alarm —
 * which clamps to "now" while due work remains — resumes the drain on a
 * fresh invocation budget. */
const OUTBOX_PASSES_PER_DRAIN = 1;
/** Debugging tail of abandoned rows kept after their divergence metric
 * fired; everything older is pruned (a dead subscriber must not grow
 * storage without bound). */
const OUTBOX_ABANDONED_KEEP = 256;

/** Phase-3 scheduled-burst bound: one alarm firing moves at most this
 * many due turns into the /plan-scheduled outbox, then re-arms
 * immediately when more are due — a burst can never balloon one alarm
 * transaction. */
const SCHEDULED_BATCH_PER_ALARM = 32;

export class NetScopeDO {
  private readonly store: SqliteScopeStore;
  private readonly host: WorkerdHost;
  private seq: ScopeSequencer | null = null;
  /** One drain at a time; a re-kick while draining is dropped (the next
   * request or defer re-kicks — rows are durable, nothing is lost). */
  private draining = false;
  /** Set by persistOutboxRow when an enqueue lands mid-drain (fix 4b):
   * the drain loop re-passes before releasing, so such rows never strand
   * until the next request. This replaces the old fresh-row COUNT probe,
   * which under bounded lane batches could not distinguish "new work"
   * from due rows parked behind a mid-backoff lane head — and would spin
   * the loop on the latter. */
  private enqueuedWhileDraining = false;
  /** Whether THIS lifetime armed the outbox retry alarm key (fix 4a);
   * gates the clear so scopes with no outbox history never touch the
   * storage alarm. Lost on eviction by design — see armOutboxRetryAlarm. */
  private outboxAlarmArmed = false;
  /** In-memory mirror of the rider residue ledger (net_scope_rider_cache),
   * hydrated lazily and appended on insert — `owns` consults it per read
   * (CO14 session witness), so a per-call SQL scan would be a hot-path
   * regression. Discarded with the sequencer on any transaction abort
   * (memory-follows-durable, fix 3). */
  private riderCacheMemo: Set<string> | null = null;
  /** Per-submit relation-owner scope hints (object → owning scope name),
   * loaded from the gateway's relate_destinations sibling for the
   * duration of one /net/submit and cleared after. The sequencer's
   * `scopeOf` option reads this map through a closure: DO requests run
   * one at a time and the sequencer's submit is synchronous inside the
   * transaction, so the per-request lifetime is race-free. Outside a
   * submit the map is empty → every delta classifies local (the
   * documented no-hints behavior). */
  private readonly relateScopeHints = new Map<string, string>();
  /** Catalog-bound rider objects for the current submit. Unlike ordinary
   * foreign mutable riders, lifecycle/property/verb writes to catalog-owned
   * objects are install-pipeline-only (CO15). The sequencer callback reads
   * this set synchronously during submit, before any local residue or fanout
   * can be committed. */
  private readonly catalogRiderObjects = new Set<string>();

  constructor(
    private readonly state: NetScopeDurableState,
    private readonly env: NetScopeEnv
  ) {
    this.store = new SqliteScopeStore(state.storage);
    // Shell-level tables (not ScopeStore row families — they are the DO's
    // delivery bookkeeping, not sequencer state): fanout subscribers, the
    // durable outbox (mirrors src/net/outbox.ts FanoutRow + a route
    // column), and the per-sender adoption high-water (CO2.5 receiver
    // idempotency for /net/adopt).
    // Subscribers carry a role (CO16): fanout receivers vs the planner
    // registry. PK is (destination, role) — one gateway commonly holds
    // BOTH roles (it mirrors fanout AND executes scheduled turns). The
    // pre-CO16 table was destination-only; migrate by the recreate idiom
    // (SQLite cannot ALTER a primary key): probe for the role column and,
    // when absent, rebuild the table in one transaction with existing
    // rows carrying role='fanout' — they were fanout receivers by
    // definition. Idempotent: a migrated (or fresh) table has the column
    // and the probe passes.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_subscribers (destination TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'fanout', delivery_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (destination, role))"
    );
    const subscriberColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_scope_subscribers)"));
    if (!subscriberColumns.some((column) => column.name === "role")) {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("ALTER TABLE net_scope_subscribers RENAME TO net_scope_subscribers_legacy");
        state.storage.sql.exec(
          "CREATE TABLE net_scope_subscribers (destination TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'fanout', delivery_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (destination, role))"
        );
        state.storage.sql.exec(
          "INSERT INTO net_scope_subscribers (destination, role) SELECT destination, 'fanout' FROM net_scope_subscribers_legacy"
        );
        state.storage.sql.exec("DROP TABLE net_scope_subscribers_legacy");
      });
    }
    const deliverySubscriberColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_scope_subscribers)"));
    if (!deliverySubscriberColumns.some((column) => column.name === "delivery_seq")) {
      state.storage.sql.exec("ALTER TABLE net_scope_subscribers ADD COLUMN delivery_seq INTEGER NOT NULL DEFAULT 0");
    }
    // Outbox columns beyond the FanoutRow mirror (ready-to-scale Phase 3;
    // must exist BEFORE any namespace holds data — cf-do-0004 freeze):
    // `scope`/`seq` duplicate the body's ordering key so a drain can read
    // a bounded LANE PREFIX in (scope, seq) order straight off an index
    // (never parse-and-sort the whole backlog), and `next_attempt_at_ms`
    // is the row's retry due-time (enqueue → 0 = due now; failure →
    // last_attempt + backoff) so dueness checks and the retry alarm are
    // one indexed lookup. The probe+ALTER covers pre-column dev worlds;
    // the backfill is idempotent (NULL rows only).
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_outbox (route TEXT NOT NULL, id TEXT NOT NULL, destination TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt_at_ms INTEGER, scope TEXT, seq INTEGER, next_attempt_at_ms INTEGER, PRIMARY KEY (route, id))"
    );
    const outboxColumns = sqlRows<{ name: string }>(state.storage.sql.exec("PRAGMA table_info(net_scope_outbox)"));
    for (const column of ["scope TEXT", "seq INTEGER", "next_attempt_at_ms INTEGER"]) {
      const name = column.split(" ")[0];
      if (!outboxColumns.some((existing) => existing.name === name)) {
        state.storage.sql.exec(`ALTER TABLE net_scope_outbox ADD COLUMN ${column}`);
      }
    }
    // One-time backfills below, gated by meta markers (review: an
    // unconditional backlog scan on EVERY construction is itself the
    // cold-DO scale class Phase 3 removes). Crash between backfill and
    // marker heals next construction — both backfills are idempotent.
    const outboxMigrated = this.store.metaMarkerPresent("migrated_outbox_lane_directory");
    if (!outboxMigrated) {
      for (const row of sqlRows<{ route: string; id: string; body: string; attempts: number; last_attempt_at_ms: number | null }>(
        state.storage.sql.exec(
          "SELECT route, id, body, attempts, last_attempt_at_ms FROM net_scope_outbox WHERE scope IS NULL OR seq IS NULL OR next_attempt_at_ms IS NULL"
        )
      )) {
        const body = JSON.parse(row.body) as FanoutBody;
        const nextAttempt =
          row.last_attempt_at_ms === null ? 0 : Number(row.last_attempt_at_ms) + OUTBOX_BACKOFF_MS(Number(row.attempts));
        state.storage.sql.exec(
          "UPDATE net_scope_outbox SET scope = ?, seq = ?, next_attempt_at_ms = ? WHERE route = ? AND id = ?",
          body.scope,
          body.seq,
          nextAttempt,
          row.route,
          row.id
        );
      }
    }
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_net_scope_outbox_due ON net_scope_outbox (status, next_attempt_at_ms)"
    );
    state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_net_scope_outbox_lane ON net_scope_outbox (route, destination, status, scope, seq)"
    );
    // Lane directory (Phase 3): one row per (route, destination) that may
    // hold pending outbox rows. Lane discovery — which destinations have
    // work, and each lane's HEAD due-time — must be O(active lanes), and
    // no SQLite index scan over the backlog gives that (DISTINCT walks
    // every pending entry, so a 10k-row stuck lane would tax every pass).
    // Maintained on enqueue (INSERT OR IGNORE) and pruned when a lane
    // drains empty; the one-time backfill (marker-gated with the column
    // backfill above) derives it for pre-directory dev worlds. A stale
    // lane row after a missed prune costs one O(1) head probe, never a
    // wrong delivery.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_outbox_lane (route TEXT NOT NULL, destination TEXT NOT NULL, PRIMARY KEY (route, destination))"
    );
    if (!outboxMigrated) {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO net_scope_outbox_lane (route, destination) SELECT DISTINCT route, destination FROM net_scope_outbox WHERE status = 'pending'"
      );
      this.store.writeMetaMarker("migrated_outbox_lane_directory");
    }
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_adopted (from_scope TEXT PRIMARY KEY, seq INTEGER NOT NULL)"
    );
    // Relation-delivery high-water (CO13): (from_scope, seq) receiver
    // idempotency for /net/relate — the same discipline as
    // net_scope_adopted, in a SEPARATE table because one committing turn
    // can legitimately produce BOTH an /adopt row and a /relate row to
    // the same owner at the same (from_scope, seq) (a ride-along write
    // plus a move whose destination anchors here); a shared counter
    // would let whichever arrived first swallow the other.
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_related (from_scope TEXT PRIMARY KEY, seq INTEGER NOT NULL)"
    );
    // Rider residue ledger (rider-read integrity, fix 1): keys of cells
    // this scope committed via CA3 ride-along but does NOT anchor. After
    // the owner adopts them they are a CACHE of the owner's fact, so any
    // later transfer out of this scope must ship them derived, never
    // authoritative-provenance (a second authoritative copy is exactly the
    // CO2.1 dual-authority violation). The re-stamp happens at the
    // serialization exit (closure()) because CellStore's authority role
    // deliberately refuses to HOLD derived cells — the sequencer's store
    // and its durable mirror keep the authoritative stamp so hydration
    // and post-state derivation stay byte-identical.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_rider_cache (key TEXT PRIMARY KEY)");
    // Scheduled-dispatch counter (CO16): a durable monotonic sequence for
    // /plan-scheduled outbox rows. It must be durable — outbox row ids
    // embed it (`<destination>/<scope>/<n>`), and a counter reset across
    // eviction could re-mint the id of a still-pending row, whose
    // ON CONFLICT DO NOTHING enqueue would silently swallow the new turn.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_sched_dispatch (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    this.host = new WorkerdHost({
      resolve: (destination) => resolveNetDestination(this.env, destination),
      env,
      waitUntil: state.waitUntil?.bind(state),
      alarmStorage: state.storage,
      metric: (event) => this.metric(event)
    });
  }

  /** Scope ids are named from the authority scope. Keeping that name as the
   * AE index isolates adaptive sampling and makes hot authorities visible. */
  private metric(event: AnalyticsMetric): void {
    const name = (this.state.id as { name?: unknown } | null | undefined)?.name;
    emitMetric(event, `net-scope:${typeof name === "string" && name.length > 0 ? name : "unnamed"}`, this.env.METRICS);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(this.env, request);
    } catch (err) {
      return json({ error: String(err) }, 401);
    }
    const url = new URL(request.url);
    // Installation must prove that a freshly deployed secret reached BOTH
    // the edge and the destination DO before the first seed. Answer before
    // sequencer hydration and drain scheduling so this route cannot create
    // world authority, advance a head, or kick deferred work.
    if (request.method === "GET" && url.pathname === "/net/probe") {
      return json({ ok: true, service: "net-scope" });
    }
    // Drain-on-reactivation (CO2.7 at-least-once): ordinary requests kick
    // pending work off their reply path. An incoming outbox delivery is
    // different: continuing /adopt -> /relate -> /fanout in the SAME CF
    // request lineage eventually trips the platform subrequest-depth cap.
    // Delivery handlers below arm a fresh alarm event instead.
    const incomingDelivery = request.method === "POST" && (url.pathname === "/net/adopt" || url.pathname === "/net/relate");
    const submitRequest = request.method === "POST" && url.pathname === "/net/submit";
    // A submit is itself reached from a gateway. Starting an old drain
    // before returning can call that still-waiting gateway and form a CF
    // request cycle (gateway -> scope -> gateway). Submit and incoming
    // delivery routes therefore continue only through a fresh alarm event.
    if (!incomingDelivery && !submitRequest) this.deferPendingDrain();
    try {
      if (request.method === "POST" && url.pathname === "/net/submit") {
        // Bare CommitSubmit (direct submits, tests) or the gateway's
        // {submit, rider_destinations, relate_destinations} sibling shape.
        const raw = (await request.json()) as
          | CommitSubmit
          | { submit: CommitSubmit; rider_destinations?: RiderDestinations; relate_destinations?: RelateDestinations };
        const submit = "submit" in raw ? raw.submit : raw;
        const riderDestinations = "submit" in raw ? (raw.rider_destinations ?? {}) : {};
        const relateDestinations = "submit" in raw ? (raw.relate_destinations ?? {}) : {};
        // Hydrate from durable identity ONLY (no scope hint): a submit
        // naming another scope must reach the SEQUENCER's step-2 check
        // and reject with the NAMED terminal `scope_mismatch` — the
        // designed verdict for the gateway's selection-pin override
        // (fix 5c: a re-plan that migrated scopes surfaces legibly).
        // Passing submit.scope here made ensureSequencer's wrong-DO
        // guard throw a bare 500 first, masking the verdict. An UNSEEDED
        // DO still needs identity from somewhere: fall back to the
        // submit's naming (its reply then comes from a fresh sequencer
        // that refuses everything else consistently).
        const seq = this.seq !== null || this.store.readMeta() !== null
          ? this.ensureSequencer(undefined, submit.stamp.catalog_epoch)
          : this.ensureSequencer(submit.scope, submit.stamp.catalog_epoch);
        const headBefore = seq.head().seq;
        const baseLag = Math.max(0, headBefore - submit.base.seq);
        // NC8a authority-side evidence: per-submit wall time + fanout rows
        // enqueued (the hot-scope serialization series — a popular room is
        // one serialized write queue, and this is its cost meter).
        const submitStarted = Date.now();
        const enqueuedBefore = this.outboxEnqueuedTotal;
        // Rider-read integrity (fix 1): capture, BEFORE the commit applies,
        // the prior version this turn observed for each rider-anchored
        // cell — the adopt-time CAS input. Must run pre-submit because the
        // accept path replaces the cells in place.
        const riderPriors = this.captureRiderPriors(seq, submit, riderDestinations);
        let reply!: CommitReply;
        // CO13: load the gateway's relation-owner hints for THIS submit —
        // the sequencer's `scopeOf` reads them to partition derived
        // relation deltas (see relateScopeHints). Cleared in finally so a
        // reject/throw can never leak hints into the next request.
        this.relateScopeHints.clear();
        this.catalogRiderObjects.clear();
        for (const [scope, entry] of Object.entries(relateDestinations)) {
          for (const object of entry.objects) this.relateScopeHints.set(object, scope);
        }
        for (const object of riderDestinations[CATALOG_SCOPE]?.objects ?? []) {
          this.catalogRiderObjects.add(object);
        }
        try {
          // The commit write-through and the outbox enqueue share ONE
          // transaction (CO2.7: rows are durable before the reply returns;
          // a crash can never separate a commit from its fanout). The
          // sequencer's internal transaction joins this outer one.
          this.discardSeqOnThrow(() =>
            this.store.transaction(() => {
              reply = seq.submit(submit);
              // Idempotent replays (head did not advance) enqueue nothing:
              // their rows were enqueued when the turn first committed.
              if (reply.status === "accepted" && reply.head.seq === headBefore + 1) {
                this.enqueueDeliveries(seq, reply, submit, riderDestinations, riderPriors, relateDestinations);
              }
            })
          );
        } finally {
          this.relateScopeHints.clear();
          this.catalogRiderObjects.clear();
        }
        // Never begin fanout in the gateway -> scope submit lineage. Even a
        // waitUntil task starts executing immediately; calling the submitting
        // gateway before this response leaves the scope creates a platform
        // recursion cycle. The durable row is already committed, so an
        // immediate alarm is the crash-safe post-reply continuation.
        this.armOutboxRetryAlarm();
        // H2b: a commit touching a session cell minted or refreshed an
        // expiry — re-derive the reap wake (gated on the touched keys so
        // the hot non-session path never pays the scan).
        if (reply.status === "accepted" && reply.touched.some((key) => key.startsWith("session:"))) {
          this.armSessionReapAlarm(seq);
        }
        this.metric({
          kind: "net_scope_submit",
          scope: seq.scope,
          status: reply.status,
          ...(reply.status === "accepted" ? { seq: reply.head.seq, touched: reply.touched.length } : { reason: reply.reason }),
          base_lag: baseLag,
          // A cached idempotent reply can also carry an old base; only a
          // fresh acceptance represents authority-side rebasing.
          rebased: reply.status === "accepted" && reply.replayed !== true && baseLag > 0,
          outbox_enqueued: this.outboxEnqueuedTotal - enqueuedBefore,
          ms: Date.now() - submitStarted
        });
        return json(reply);
      }
      if (request.method === "POST" && url.pathname === "/net/subscribe") {
        const body = (await request.json()) as { destination?: string; role?: string };
        if (!body.destination) throw new Error("subscribe requires a destination");
        // CO16 subscriber roles: default stays fanout (every pre-role
        // caller keeps its behavior); an unknown role is a caller bug —
        // refuse loudly rather than park it under a role nothing drains.
        const role: SubscriberRole = (body.role ?? "fanout") as SubscriberRole;
        if (role !== "fanout" && role !== "planner") {
          throw new Error(`subscribe role must be "fanout" or "planner", got ${JSON.stringify(body.role)}`);
        }
        this.state.storage.sql.exec(
          "INSERT INTO net_scope_subscribers (destination, role) VALUES (?, ?) ON CONFLICT(destination, role) DO NOTHING",
          body.destination,
          role
        );
        // A newly registered planner must pick up rows parked while no
        // planner existed (rearmAlarm deliberately never arms for
        // overdue rows): arm an immediate wake so the durable alarm()
        // path — the single dispatch point — moves them to the outbox.
        if (role === "planner") {
          const now = this.host.now();
          // Indexed EXISTS probe (review #1) — never a read-and-parse of
          // every parked row on the subscribe path.
          if (this.store.hasScheduledDue(now)) {
            this.host.setAlarm(SCOPE_ALARM_KEY, now, async () => {});
          }
        }
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/net/adopt") {
        const body = (await request.json()) as {
          from_scope: string;
          seq: number;
          cells: Cell[];
          prior_versions?: Record<string, string>;
        };
        const adopted = this.adopt(body);
        // A non-empty adoption enqueued fanout rows. Continue from a
        // fresh alarm event so delivery chains cannot recurse through
        // Cloudflare's per-request subrequest-depth limit.
        this.armOutboxRetryAlarm();
        // H2b: the folded session mint reaches its cluster authority via
        // adoption — a session cell in the batch (re)arms the reap wake.
        if (adopted.applied && body.cells.some((cell) => cell.kind === "session")) {
          this.armSessionReapAlarm(this.ensureSequencer());
        }
        return json(adopted);
      }
      if (request.method === "POST" && url.pathname === "/net/relate") {
        const body = (await request.json()) as {
          from_scope: string;
          seq: number;
          deltas: RelationDelta[];
          observations?: unknown[];
        };
        const related = this.relate(body);
        // Refan from a fresh alarm event; never extend the incoming
        // /relate delivery's request lineage.
        this.armOutboxRetryAlarm();
        return json(related);
      }
      if (request.method === "POST" && url.pathname === "/net/attest") {
        // CO2.3 rider-read attestation: report this authority's current
        // version for each requested cell key, plus the head the report
        // was taken at. Absent cells attest "absent" — the same token
        // read-version validation uses, so an attested absence compares
        // directly against a planned "absent" read. `ordering_parents`
        // (R3) asks for the current ordering content version of each named
        // parent the same way — an ordering with no edges attests the
        // empty-rows version, the ordering analogue of "absent". Read-only:
        // no state changes, no head movement.
        const body = (await request.json()) as { keys: string[]; ordering_parents?: Array<{ container?: unknown; parent?: unknown }> };
        const seq = this.ensureSequencer();
        const orderingParents = Array.isArray(body.ordering_parents) ? body.ordering_parents : [];
        for (const ordering of orderingParents) {
          if (typeof ordering?.container !== "string" || !ordering.container
            || (ordering.parent !== null && !(typeof ordering.parent === "string" && ordering.parent))) {
            throw netError("E_INVARG", "attest ordering_parents entries require container plus parent (nonempty ref or null)", { ordering });
          }
        }
        return json({
          scope: seq.scope,
          catalog_epoch: seq.catalogEpoch,
          owner_head: seq.head(),
          cells: body.keys.map((key) => ({ key, version: seq.store.get(key)?.version ?? "absent" })),
          ...(orderingParents.length > 0
            ? { orderings: orderingParents.map((ordering) => ({
                container: ordering.container as string,
                parent: ordering.parent as string | null,
                version: orderedChildrenVersion(seq.orderedChildren(ordering.container as string, ordering.parent as string | null))
              })) }
            : {})
        });
      }
      if (request.method === "POST" && url.pathname === "/net/room-roster") {
        const body = (await request.json()) as { room?: unknown };
        if (typeof body.room !== "string" || !body.room) throw new Error("room-roster requires room");
        const seq = this.ensureSequencer();
        const lineage = seq.store.get(cellKey("object_lineage", body.room))?.value as { name?: unknown } | undefined;
        const rows = roomRosterRows(
          seq.relations().values(),
          body.room,
          typeof lineage?.name === "string" && lineage.name ? lineage.name : body.room,
          this.host.now()
        );
        return json({ scope: seq.scope, head: seq.head(), room: body.room, rows });
      }
      if (request.method === "POST" && url.pathname === "/net/ordered-children") {
        // Owner-computed ordered children of a parent (the ordering analogue
        // of /net/room-roster). Reads this scope's write-time-sorted authored
        // and foreign-relation indexes for the parent and returns one bounded
        // list — never the edge cells themselves or a whole-scope scan.
        // `parent: null` lists the ordering roots.
        const body = (await request.json()) as { container?: unknown; parent?: unknown };
        if (typeof body.container !== "string" || !body.container) {
          throw netError("E_INVARG", "ordered-children requires a nonempty container ref", { container: body.container ?? null });
        }
        const parent = body.parent === null ? null
          : typeof body.parent === "string" && body.parent ? body.parent
          : undefined;
        if (parent === undefined) {
          throw netError("E_INVARG", "ordered-children requires parent (nonempty string ref or null)", { parent: body.parent ?? null });
        }
        const seq = this.ensureSequencer();
        // Bounded scan (P2.4): the per-parent edge index, O(children-of-parent),
        // not a whole-scope cell scan. This full list is for DISPLAY
        // (list_items); a MUTATION uses /net/ordered-neighbors below instead.
        const rows = seq.orderedChildren(body.container, parent);
        // `version` is the content address of the ordering (P1.1): the reader
        // attests it, and this scope re-derives + validates it at submit so a
        // concurrent same-parent insert makes the plan stale.
        return json({ scope: seq.scope, head: seq.head(), container: body.container, parent, rows, version: orderedChildrenVersion(rows) });
      }
      if (request.method === "POST" && url.pathname === "/net/ordered-neighbors") {
        // BOUNDED neighbour read for a mutation (P2.4): answers ONE
        // OrderedNeighborsQuery — the two ranks bounding an insertion slot
        // (`index: null` = append; the slot is CLAMPED, range policy stays in
        // the verb), the sibling count after `exclude`, and the queried
        // `child`'s current slot — NEVER the full sibling list, so the
        // response is O(1) regardless of how wide the parent is. Computed by
        // the shared `orderedNeighborsFromRows` so this authority answer and
        // the local runtime's own scan agree exactly. `version` is the same
        // per-parent ordering content address the full projection carries;
        // the plan attests it identically (P1.1).
        const body = (await request.json()) as { container?: unknown; parent?: unknown; index?: unknown; exclude?: unknown; child?: unknown };
        if (typeof body.container !== "string" || !body.container) {
          throw netError("E_INVARG", "ordered-neighbors requires a nonempty container ref", { container: body.container ?? null });
        }
        const parent = body.parent === null ? null
          : typeof body.parent === "string" && body.parent ? body.parent
          : undefined;
        if (parent === undefined) {
          throw netError("E_INVARG", "ordered-neighbors requires parent (nonempty string ref or null)", { parent: body.parent ?? null });
        }
        // Strict field validation (Adv-a): a malformed optional field must be
        // REFUSED, never silently coerced into a different-but-valid query
        // (index:"0" is not an append; exclude:42 is not "no exclusion").
        // Out-of-RANGE numeric indices stay clamped by design — range policy
        // lives in the calling verb; TYPE policy lives here.
        if (body.index !== undefined && body.index !== null && !(typeof body.index === "number" && Number.isFinite(body.index))) {
          throw netError("E_INVARG", "ordered-neighbors index must be a finite number (or null/absent for append)", { index: body.index });
        }
        if (body.exclude !== undefined && body.exclude !== null && !(typeof body.exclude === "string" && body.exclude)) {
          throw netError("E_INVARG", "ordered-neighbors exclude must be a nonempty string ref (or null/absent)", { exclude: body.exclude });
        }
        if (body.child !== undefined && body.child !== null && !(typeof body.child === "string" && body.child)) {
          throw netError("E_INVARG", "ordered-neighbors child must be a nonempty string ref (or null/absent)", { child: body.child });
        }
        const seq = this.ensureSequencer();
        const rows = seq.orderedChildren(body.container, parent);
        const answer = orderedNeighborsFromRows(rows, {
          index: body.index === undefined || body.index === null ? null : (body.index as number),
          exclude: (body.exclude as string | undefined) ?? null,
          child: (body.child as string | undefined) ?? null
        });
        return json({ scope: seq.scope, head: seq.head(), container: body.container, parent, ...answer, version: orderedChildrenVersion(rows) });
      }
      if (request.method === "POST" && url.pathname === "/net/closure") {
        const body = (await request.json()) as {
          keys: string[];
          known?: string[];
          objects?: string[];
          relations?: boolean;
        };
        return json(this.closure(body.keys, body.known ?? [], body.objects ?? [], body.relations === true));
      }
      if (request.method === "GET" && url.pathname === "/net/head") {
        const seq = this.ensureSequencer();
        // object_counter (client-shell phase i): the allocation floor the
        // gateway threads into planning so creates never re-mint an id
        // this authority already holds. Additive field (v1 add-only).
        return json({ scope: seq.scope, catalog_epoch: seq.catalogEpoch, head: seq.head(), object_counter: seq.objectCounter() });
      }
      if (request.method === "POST" && url.pathname === "/net/seed") {
        const body = (await request.json()) as {
          scope: string;
          catalog_epoch: string;
          cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>;
          relations?: RelationRow[];
        };
        // M9 seed-time epoch guard: a scope seeded at epoch A must refuse
        // a seed stamped with epoch B — without this, ensureSequencer
        // resolves the epoch from durable meta (meta wins) and the new
        // cells would be SILENTLY stamped with the old epoch, hiding a
        // catalog-install disagreement. Idempotent re-seed at the SAME
        // epoch stays a no-op-shaped success (the install pipeline's
        // retry posture). Epoch RECONCILIATION is the catalog migration
        // path's job (aged-world lane), never a silent adoption here.
        const durableEpoch = this.seq?.catalogEpoch ?? this.store.readMeta()?.catalog_epoch;
        if (durableEpoch !== undefined && durableEpoch !== body.catalog_epoch) {
          throw netError("E_EPOCH_MISMATCH", "seed epoch disagrees with the scope's durable epoch", {
            scope: body.scope,
            seed_epoch: body.catalog_epoch,
            scope_epoch: durableEpoch
          });
        }
        const seq = this.ensureSequencer(body.scope, body.catalog_epoch);
        this.discardSeqOnThrow(() => seq.seed(body.cells, body.relations ?? []));
        // H2b: seeded session cells arm the reap wake too.
        if (body.cells.some((cell) => cell.kind === "session")) this.armSessionReapAlarm(seq);
        return json({ ok: true, scope: seq.scope, head: seq.head() });
      }
      if (request.method === "POST" && url.pathname === "/net/repair-relations") {
        const body = (await request.json()) as { relations?: RelationRow[] };
        const rows = Array.isArray(body.relations) ? body.relations : [];
        const seq = this.ensureSequencer();
        for (const row of rows) {
          if (row.relation !== "contents" || !row.owner || !row.member) {
            throw netError("E_INVARG", "relation repair accepts only concrete contents rows", { row });
          }
          // A contents row belongs here only when this authority owns the
          // containing object.  This admits cross-scope members (pinboard in
          // deck) while refusing an operator request aimed at the wrong room.
          if (!seq.store.has(cellKey("object_lineage", row.owner))) {
            throw netError("E_INVARG", "relation repair owner is not authoritative at this scope", {
              scope: seq.scope,
              owner: row.owner,
              member: row.member
            });
          }
        }
        const repaired = this.discardSeqOnThrow(() => this.store.transaction(() => {
          const deltas: RelationDelta[] = rows.map((row) => ({ op: "add", row }));
          const result = seq.applyForeignRelationDeltas(deltas, {
            from_scope: "operator:install-contents",
            seq: seq.head().seq + 1
          });
          if (result.status === "applied") {
            const changed = new Set(result.changed);
            const applied = deltas.filter((delta) => changed.has(relationKey(delta.row.relation, delta.row.owner, delta.row.member)));
            const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
              this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
            );
            for (const { destination, delivery_seq } of subscribers) {
              this.persistFanoutRow(destination, delivery_seq, {
                scope: seq.scope,
                seq: result.head.seq,
                cells: [],
                observations: [],
                relations: applied
              });
            }
          }
          return result;
        }));
        this.armOutboxRetryAlarm();
        return json({ ok: true, scope: seq.scope, ...repaired });
      }
      if (request.method === "POST" && url.pathname === "/net/repair-definitions") {
        const body = (await request.json()) as {
          cells?: Array<Pick<Cell, "kind" | "object" | "name" | "value">>;
        };
        const cells = Array.isArray(body.cells) ? body.cells : [];
        const seq = this.ensureSequencer();
        if (seq.scope !== CATALOG_SCOPE || cells.length === 0 || cells.length > 16) {
          throw netError("E_INVARG", "definition repair requires 1..16 catalog cells", { scope: seq.scope, count: cells.length });
        }
        const keys = new Set<string>();
        for (const cell of cells) {
          if (!cell || typeof cell !== "object" || typeof cell.kind !== "string" ||
              typeof cell.object !== "string" || typeof cell.name !== "string" ||
              !Object.prototype.hasOwnProperty.call(cell, "value")) {
            throw netError("E_INVARG", "definition repair requires complete verb cells");
          }
          const key = cellKey(cell.kind, cell.object, cell.name);
          const page = cell.value as Record<string, unknown> | null;
          if (cell.kind !== "verb_bytecode" || !cell.object.startsWith("$") || !cell.name ||
              !page || typeof page !== "object" || Array.isArray(page) || page.name !== cell.name ||
              !seq.store.has(key) || keys.has(key)) {
            throw netError("E_INVARG", "definition repair accepts unique existing bootstrap verb pages only", { key });
          }
          keys.add(key);
        }
        const repaired = this.discardSeqOnThrow(() => this.store.transaction(() => {
          const result = seq.operatorRepairDefinitions(cells);
          if (result.status === "applied") {
            const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
              this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
            );
            for (const { destination, delivery_seq } of subscribers) {
              this.persistFanoutRow(destination, delivery_seq, {
                scope: seq.scope,
                seq: result.head.seq,
                cells: result.cells,
                observations: []
              });
            }
          }
          return result;
        }));
        this.armOutboxRetryAlarm();
        return json({ ok: true, scope: seq.scope, status: repaired.status, head: repaired.head, changed: repaired.cells.map((cell) => cell.key) });
      }
      if (request.method === "POST" && url.pathname === "/net/activate") {
        // The NC1 activation state machine as a DEDICATED operator op
        // (reviewer finding 1): /net/seed refuses once a scope has
        // committed, so activation/deactivation — which legitimately
        // happen around verification traffic — get their own signed
        // route that writes exactly the one activation cell.
        const body = (await request.json()) as {
          scope: string;
          catalog_epoch: string;
          active_epoch: string | null;
          expected_active_epoch?: string | null;
        };
        const durableEpoch = this.seq?.catalogEpoch ?? this.store.readMeta()?.catalog_epoch;
        if (durableEpoch !== undefined && durableEpoch !== body.catalog_epoch) {
          throw netError("E_EPOCH_MISMATCH", "activation epoch disagrees with the scope's durable epoch", {
            scope: body.scope,
            activation_epoch: body.catalog_epoch,
            scope_epoch: durableEpoch
          });
        }
        const seq = this.ensureSequencer(body.scope, body.catalog_epoch);
        // V3 finding 5 (P1): activation is a STATE TRANSITION, and
        // internal signatures replay freely within the skew window — a
        // captured/reordered activation could restore an old state. CAS:
        // the caller declares the value it expects to overwrite. Reading
        // it back equal is idempotent success (safe replay); a mismatch
        // refuses E_STALE_HEAD so a stale transition can never win.
        if (body.expected_active_epoch !== undefined) {
          const cur = seq.store.get(cellKey("property_cell", "$system", "net_active_epoch"))?.value as
            | { value?: unknown }
            | undefined;
          const currentActive = cur && "value" in cur ? (cur.value as string | null) : null;
          if (currentActive === body.active_epoch) {
            return json({ ok: true, scope: seq.scope, active_epoch: body.active_epoch, idempotent: true });
          }
          if (currentActive !== body.expected_active_epoch) {
            throw netError("E_STALE_HEAD", "activation CAS: expected value does not match current", {
              scope: body.scope,
              expected: body.expected_active_epoch,
              current: currentActive
            });
          }
        }
        this.discardSeqOnThrow(() =>
          seq.operatorActivationWrite({
            kind: "property_cell",
            object: "$system",
            name: "net_active_epoch",
            value: { value: body.active_epoch }
          })
        );
        return json({ ok: true, scope: seq.scope, active_epoch: body.active_epoch });
      }
      if (request.method === "POST" && url.pathname === "/net/schedule") {
        const body = (await request.json()) as { scope: string; catalog_epoch: string; turn: ScheduledTurn };
        const seq = this.ensureSequencer(body.scope, body.catalog_epoch);
        // Persist meta before parking: a scheduled-only scope must still
        // rehydrate after eviction (the alarm handler has only durable
        // state to name the scope with).
        if (this.store.readMeta() === null) {
          this.store.writeMeta({ scope: seq.scope, catalog_epoch: seq.catalogEpoch, head: seq.head() });
        }
        this.discardSeqOnThrow(() => seq.schedule(body.turn, this.host.now()));
        this.rearmAlarm(this.host.now());
        return json({ ok: true, next_alarm_at: seq.nextAlarmAt() });
      }
      return json({ error: `no such route: ${request.method} ${url.pathname}` }, 404);
    } catch (err) {
      if (isNetError(err)) {
        return json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.code === "E_MISSING_STATE" ? 404 : 400);
      }
      return json({ error: String(err) }, 500);
    }
  }

  /**
   * DO alarm wake (CO2.8, CO16). The sequencer rehydrates from durable
   * state — in-memory callbacks never survive eviction, which is exactly
   * why the durable path re-derives everything here.
   *
   * Scheduled-turn execution (CO16): PEEK first, then — only when a
   * planner-role subscriber is registered — move each due turn from the
   * scheduled row family to a durable /plan-scheduled outbox row in ONE
   * transaction (the dueTurns pop joins it), so the turn changes family
   * atomically: never lost (a crash before the transaction leaves it
   * parked; after it, the outbox's at-least-once drain owns it) and
   * never duplicated (it exists in exactly one family at any instant,
   * and the planner's `sched:<id>:<at_logical_time>` idempotency key
   * de-dupes redeliveries — CO2.5). With NO planner registered the due
   * turns stay parked with the named metric — the specified no-planner
   * state (fix 8a's non-destructive peek): destructively popping work
   * nothing can execute would break CO2.8 silently. Re-arming considers
   * only FUTURE turns (parked overdue rows cannot spin the alarm) and
   * outbox retries.
   */
  async alarm(): Promise<void> {
    // Outbox liveness (fix 4a): a QUIET scope must still retry failed
    // deliveries — this alarm is the retry engine when no request ever
    // arrives to trigger drain-on-reactivation. The drain's own finally
    // re-arms for the next backoff window if rows remain.
    this.deferPendingDrain();
    const meta = this.store.readMeta();
    if (meta === null) {
      // Nothing durable names this scope — a spurious wake. Clear.
      // (Outbox rows imply meta: they only exist after an accepted
      // commit, whose write-through persists meta in the same
      // transaction — so this clear cannot strand a retry.)
      await this.state.storage.deleteAlarm();
      return;
    }
    const seq = this.ensureSequencer(meta.scope, meta.catalog_epoch);
    const now = this.host.now();
    // H2b: reap expired session cells (and their presence rows) before
    // the scheduled-turn machinery — an owner-sequenced cleanup event.
    this.reapSessionsAtAlarm(seq, now);
    // Phase 3: one firing handles a BOUNDED batch of due turns; leftovers
    // re-arm immediately below (planner registered) or stay parked
    // (no-planner — future-only re-arm, so overdue rows cannot spin).
    const due = seq.peekDue(now, SCHEDULED_BATCH_PER_ALARM);
    let planner: string | null = null;
    if (due.length > 0) {
      planner = this.plannerDestination();
      if (planner === null) {
        // The specified no-planner state (CO16): rows stay parked, one
        // named metric per due turn (bounded by the batch) per firing.
        for (const turn of due) {
          this.metric({
            kind: "net_scope_scheduled_turn_fired",
            scope: seq.scope,
            id: turn.id,
            at_logical_time: turn.at_logical_time,
            fired_at: now,
            reason: "no_planner",
            note: "parked: no planner-role subscriber registered (CO16); row retained"
          });
        }
      } else {
        // Narrowed copy for the closures below (TS loses a `let`'s
        // narrowing across function boundaries).
        const plannerDest = planner;
        // Atomic family move: outbox enqueue + scheduled-row pop share
        // ONE transaction (dueTurns' internal transaction joins). The
        // dueTurns pop mutates sequencer memory, so the whole block is
        // discard-on-throw (fix 3): an aborted transaction rehydrates
        // the queue from the rolled-back store instead of leaving
        // memory ahead of SQLite.
        this.discardSeqOnThrow(() =>
          this.store.transaction(() => {
            for (const turn of seq.dueTurns(now, SCHEDULED_BATCH_PER_ALARM)) {
              const dispatchBody: PlanScheduledOutboxBody = {
                scope: seq.scope,
                seq: this.nextScheduledDispatch(),
                cells: [],
                observations: [],
                scheduled_turn: turn,
                catalog_epoch: seq.catalogEpoch
              };
              this.persistOutboxRow("/plan-scheduled", plannerDest, dispatchBody);
            }
          })
        );
        for (const turn of due) {
          this.metric({
            kind: "net_scope_scheduled_turn_dispatched",
            scope: seq.scope,
            id: turn.id,
            at_logical_time: turn.at_logical_time,
            fired_at: now,
            // NC8a scheduler-lag series: how far past due the dispatch
            // ran (alarm backlog / contention shows up here first).
            lag_ms: Math.max(0, now - turn.at_logical_time),
            planner
          });
        }
        this.host.defer(() => this.drainOutbox());
      }
    }
    // Phase 3 immediate re-arm: a planner-dispatched batch that left due
    // turns parked wakes again NOW (each firing makes batch-sized
    // progress); otherwise the wake is the next FUTURE turn. The
    // no-planner overdue rows deliberately never re-arm (no spin).
    const moreDueNow = planner !== null && seq.peekDue(now, 1).length > 0;
    this.rearmAlarm(now, { dueNow: moreDueNow });
    // H2b: re-derive the next session-expiry wake from durable state
    // (the reap above removed everything currently expired, so only
    // future "ok" expiries arm — never a busy loop).
    this.armSessionReapAlarm(seq);
  }

  /**
   * H2b: the session reaper (alarm-driven). Delegates the semantics to
   * ScopeSequencer.reapExpiredSessions (one owner-sequenced batch — see
   * its doc for why that path was chosen over a synthetic turn) and owns
   * the DELIVERY half here, in the SAME transaction as the reap (CO2.7:
   * a crash can never separate the cleanup from its propagation):
   *
   * - local presence removals refan to this scope's fanout subscribers
   *   at the reap's advanced head seq (mirrors drop the rows);
   * - a reaped session whose last presence room anchors at ANOTHER scope
   *   gets a /net/relate remove delta addressed by the CO15
   *   `room:<owner>` naming convention (the shell's only topology
   *   knowledge; a misaddressed row abandons as the named
   *   net_scope_outbox_abandoned divergence, and the stale presence row
   *   at the owner is display-only residue — audiences filter through
   *   live sessions, so it can never resurrect delivery).
   *
   * Session-cell deletions do NOT fan out (documented on the sequencer
   * method: derived copies self-expire by value).
   */
  private reapSessionsAtAlarm(seq: ScopeSequencer, now: number): void {
    const result = this.discardSeqOnThrow(() =>
      this.store.transaction(() => {
        const reap = seq.reapExpiredSessions(now, (id) => this.ownsSessionCell(seq, id));
        if (reap.status !== "applied") return reap;
        const retiredCells = reap.reaped.flatMap((entry) => {
          if (!entry.retiredActor || entry.actor === null) return [];
          const cell = seq.store.get(cellKey("object_live", entry.actor));
          return cell ? [cell] : [];
        });
        if (reap.localRemovals.length > 0 || retiredCells.length > 0) {
          const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
            this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
          );
          for (const { destination, delivery_seq } of subscribers) {
            this.persistFanoutRow(destination, delivery_seq, {
              scope: seq.scope,
              seq: reap.head.seq,
              cells: retiredCells,
              observations: [],
              relations: reap.localRemovals
            });
          }
        }
        // Foreign presence rows: group remove deltas per owning scope.
        const locallyRemoved = new Set(
          reap.localRemovals.map((delta) => relationKey(delta.row.relation, delta.row.owner, delta.row.member))
        );
        const byScope = new Map<string, RelationDelta[]>();
        for (const entry of reap.reaped) {
          if (entry.activeScope === null) continue;
          // A room whose lineage this scope holds is a LOCAL owner — its
          // row (if any) was removed in the batch above.
          if (seq.store.has(cellKey("object_lineage", entry.activeScope))) continue;
          const owningScope = `room:${entry.activeScope}`;
          const rows = [
            { relation: "session_presence", owner: entry.activeScope, member: entry.session },
            ...(entry.retiredActor && entry.actor !== null
              ? [{ relation: "contents", owner: entry.activeScope, member: entry.actor }]
              : [])
          ];
          for (const row of rows) {
            if (locallyRemoved.has(relationKey(row.relation, row.owner, row.member))) continue;
            byScope.set(owningScope, [...(byScope.get(owningScope) ?? []), { op: "remove", row }]);
          }
        }
        for (const [owningScope, deltas] of byScope) {
          this.persistOutboxRow("/relate", `scope:${owningScope}`, {
            scope: seq.scope,
            seq: reap.head.seq,
            cells: [],
            observations: [],
            relations: deltas
          });
        }
        return reap;
      })
    );
    if (result.status === "applied") {
      this.metric({
        kind: "net_session_reaped",
        scope: seq.scope,
        sessions: result.reaped.map((entry) => entry.session)
      });
      this.host.defer(() => this.drainOutbox());
    }
  }

  /**
   * H2b: arm the session-reaper wake to the EARLIEST future expiry among
   * owned session cells. Only cells validating "ok" arm: an expired cell
   * is reaped by the very pass that calls this, and a malformed cell
   * (which can never reap) must not spin the alarm. Called wherever
   * session cells can appear or change: submit-accept touching a session
   * key, seed carrying session cells, adopt delivering the folded mint,
   * and the end of every alarm pass.
   */
  private armSessionReapAlarm(seq: ScopeSequencer): void {
    const now = this.host.now();
    let next: number | null = null;
    for (const key of seq.store.keys()) {
      if (!key.startsWith("session:")) continue;
      const cell = seq.store.get(key);
      if (!cell || !this.ownsSessionCell(seq, cell.object)) continue;
      if (validateSessionCell(cell, now) !== "ok") continue;
      const expiresAt = (cell.value as { expiresAt?: unknown } | null)?.expiresAt;
      if (typeof expiresAt !== "number") continue; // no expiry: nothing to reap
      if (next === null || expiresAt < next) next = expiresAt;
    }
    this.host.setAlarm(SESSION_ALARM_KEY, next, async () => {
      // Durable wake path is alarm() (the WorkerdHost contract).
    });
  }

  /**
   * The planner destination for scheduled-turn dispatch (CO16): the
   * lexicographically FIRST planner-role subscriber — deterministic, so
   * repeated alarms (and re-fires after a crash) address the same
   * planner and its reply cache. Each outbox row targets this SINGLE
   * destination; failover to other planners is retry policy (the
   * planner lane halts/backs off/abandons like any outbox lane —
   * abandonment is the named net_scope_outbox_abandoned divergence, and
   * multi-planner election is deliberately out of scope). Null when no
   * planner is registered — the specified parked state.
   */
  private plannerDestination(): string | null {
    const rows = sqlRows<{ destination: string }>(
      this.state.storage.sql.exec(
        "SELECT destination FROM net_scope_subscribers WHERE role = 'planner' ORDER BY destination ASC LIMIT 1"
      )
    );
    return rows.length > 0 ? rows[0].destination : null;
  }

  /** Next durable scheduled-dispatch sequence number (see the
   * net_scope_sched_dispatch comment in the constructor). Called only
   * inside the alarm's move transaction. */
  private nextScheduledDispatch(): number {
    this.state.storage.sql.exec(
      "INSERT INTO net_scope_sched_dispatch (id, n) VALUES ('dispatch', 1) ON CONFLICT(id) DO UPDATE SET n = n + 1"
    );
    const rows = sqlRows<{ n: number }>(this.state.storage.sql.exec("SELECT n FROM net_scope_sched_dispatch WHERE id = 'dispatch'"));
    return Number(rows[0]?.n ?? 1);
  }

  /**
   * Lazy hydration: build the sequencer on first need, entirely from the
   * durable store. Durable meta wins over request-supplied identity —
   * requests may then still be rejected by the sequencer's own scope/
   * epoch validation (a stale-epoch submit rejects with `stale_epoch`,
   * the named CO8 reseed path, rather than being masked here).
   */
  private ensureSequencer(scope?: string, catalogEpoch?: string): ScopeSequencer {
    if (this.seq) {
      if (scope !== undefined && scope !== this.seq.scope) {
        // One DO instance is one scope: a request for a different scope
        // means the caller routed to the wrong DO — deployment bug.
        throw new Error(`NetScopeDO is ${this.seq.scope}; request names ${scope}`);
      }
      return this.seq;
    }
    const meta = this.store.readMeta();
    const resolvedScope = meta?.scope ?? scope;
    const resolvedEpoch = meta?.catalog_epoch ?? catalogEpoch;
    if (resolvedScope === undefined || resolvedEpoch === undefined) {
      throw netError("E_MISSING_STATE", "scope has no durable state and the request names none", {
        has_meta: meta !== null
      });
    }
    if (meta !== null && scope !== undefined && scope !== meta.scope) {
      throw new Error(`NetScopeDO storage is ${meta.scope}; request names ${scope}`);
    }
    const seq: ScopeSequencer = new ScopeSequencer(resolvedScope, resolvedEpoch, {
      durable: this.store,
      // CO4 step 1 (CO14): validate the submit's session story — every
      // session read plus the transcript's session field — from this
      // authority's own cells when owned, else via the CO2.3 attestation
      // the submit carries; mint writes validate their written value.
      // Semantics live in src/net/sessions.ts; the shell only supplies
      // the ownership witness, the store read, and the clock.
      authorize: (submit) =>
        authorizeSessionSubmit(submit, {
          ownsSession: (id) => this.ownsSessionCell(seq, id),
          readSession: (id) => seq.store.get(cellKey("session", id)),
          now: () => this.host.now(),
          // Identity-door exclusiveMint occupancy witness: this cluster's
          // session cells for the actor (the store index). No residue
          // filter needed: a session's authority IS its actor's cluster
          // (the classification rule), so a cell for THIS actor held
          // HERE is authoritative by construction — a foreign copy of
          // this actor's session cannot exist at its own cluster.
          sessionsForActor: (actor) =>
            seq.store.sessionCellsForActor(actor).map((cell) => ({ id: cell.key.slice("session:".length), cell }))
        }),
      // Ownership wiring (Phase-3 hardening fix 2). Fixed-assignment rule,
      // in force until the Phase-3.5 topology section lands anchor-map-
      // driven ownership: a scope owns an object iff its store holds
      // object_lineage:<object> — i.e. the object was part of this scope's
      // own seeded/committed population. Rider adoption and the rider
      // residue cache only ever carry touched VALUE cells (never lineage),
      // so a ride-along cannot spuriously grant ownership here. Reads of
      // non-owned cells are skipped at CO4 step 7 by the sequencer: their
      // freshness is the owning scope's + the adopt-time prior-version
      // CAS's job (CO2.4; notes/2026-07-06-rider-read-integrity.md).
      //
      // CO14 addendum: session cells key on session ids, which never have
      // lineage — a scope owns a session iff it HOLDS the cell (the mint
      // committed here, or the seed partitioned it here with its actor)
      // AND the cell is not rider residue (a session cell that rode along
      // in a CA3 commit is a cache of the owner's fact; claiming
      // ownership of it would let this scope validate reads against a
      // stale copy — the ownsSessionCell helper excludes the ledger).
      owns: (object) => seq.store.has(cellKey("object_lineage", object)) || this.ownsSessionCell(seq, object),
      // CO13 relation-owner classification: the gateway's per-submit
      // relate_destinations hints (anchor topology is gateway knowledge —
      // the same rule as rider_destinations); an unhinted owner is local.
      // The closure reads the mutable hint map so one sequencer instance
      // serves every submit (hints are loaded/cleared per request).
      scopeOf: (object) => this.relateScopeHints.get(object) ?? seq.scope,
      // CO15 authority enforcement. At the catalog authority every ordinary
      // lifecycle/property/verb write is install-pipeline-only. At another
      // committing scope, the gateway's normal CA3 rider routing identifies
      // catalog-owned targets; reject before that scope can retain/fan out a
      // poisoned foreign copy. /adopt reaches the catalog authority and is
      // covered by the first branch even for an old sender.
      catalogMutationForbidden: (object) =>
        resolvedScope === CATALOG_SCOPE || this.catalogRiderObjects.has(object)
    });
    this.seq = seq;
    return this.seq;
  }

  /**
   * Lineage-closed transfer for the requested keys (`keys: ["*"]` = the
   * full scope cell set — the CO7 repair/maintenance state-transfer case;
   * scopes are room-sized by design, which is what keeps "*" bounded).
   * Requested keys always ship when present; `known` only relieves the
   * lineage-closure requirement (how transfers stay small without
   * reshipping the class chain — CO7). A requested key that is absent
   * ships nothing: at the receiver, absence after an accepted commit
   * means the cell was deleted.
   *
   * Phase 4 (targeted warming): `objects` selects EVERY cell of each
   * named object plus its transitive class chain (the authority-side
   * twin of the Phase-1 seed slice — the chain walk and per-object cell
   * reads ride the CellStore indexes), so a cold client path can warm
   * exactly what its session needs instead of copying the scope.
   * `withRelations` makes ANY closure carry the scope's current relation
   * rows (CO13) — the roster backfill a subscriber needs — without also
   * copying every cell the way `"*"` does.
   */
  private closure(
    keys: string[],
    known: string[],
    objects: string[] = [],
    withRelations = false
  ): CellTransfer & { scope: string; head: ScopeHead; catalog_epoch: string; relations?: RelationRow[] } {
    const seq = this.ensureSequencer();
    const store = seq.store;
    const wantAll = keys.length === 1 && keys[0] === "*";
    const cells = new Map<string, Cell>();
    const requested = wantAll ? [...store.keys()] : [...keys];
    // Objects mode: fixed-point over each object's PARENT chain (verb
    // pages and property defs up the class chain — inherited dispatch
    // resolves at the receiver without a per-cell miss→pull round each)
    // AND its ANCHOR chain (the CO15 topology walk classifies an object
    // by anchors; a receiver holding the object but not its anchor's
    // lineage cannot even route a turn at it — E_LINEAGE at the
    // classifier, not a repairable miss). Then every cell of every
    // chained object, plus every SESSION cell whose actor is a NAMED
    // object: the move chain's primary-session decision ENUMERATES the
    // planning world's sessions (the Phase-1 seed-completeness lesson),
    // so a receiver holding some of an actor's sessions but not all
    // would mis-designate a non-primary session as primary and
    // physically move the shared body on a presence-only transition.
    // All three expansions are short by design (class depth, room-sized
    // anchoring, one actor's sessions) — O(session need).
    if (!wantAll && objects.length > 0) {
      const chain = new Set(objects);
      for (;;) {
        let added = false;
        for (const object of [...chain]) {
          const lineage = store.get(cellKey("object_lineage", object));
          const value =
            lineage && typeof lineage.value === "object" && lineage.value
              ? (lineage.value as { parent?: unknown; anchor?: unknown })
              : undefined;
          for (const next of [value?.parent, value?.anchor]) {
            if (typeof next === "string" && next && !chain.has(next)) {
              chain.add(next);
              added = true;
            }
          }
        }
        if (!added) break;
      }
      for (const object of chain) {
        for (const cell of store.cellsForObject(object)) requested.push(cell.key);
      }
      for (const object of objects) {
        for (const cell of store.sessionCellsForActor(object)) requested.push(cell.key);
      }
      // ROSTER footprint (client-shell phase i — mirrors the seed
      // slice's rule in plan.ts): each NAMED object's members ride
      // minimally (lineage + live + aliases) so a warm gateway can match
      // names against the room's contents; full member cells arrive on
      // actual touch via the repair loop.
      for (const object of objects) {
        for (const member of store.membersAt(object)) {
          for (const key of [`object_lineage:${member}`, `object_live:${member}`, `property_cell:${member}:aliases`]) {
            if (store.has(key)) requested.push(key);
          }
        }
      }
    }
    for (const key of requested) {
      const cell = store.get(key);
      if (cell) cells.set(key, cell);
    }
    const knownSet = new Set(known);
    // Close over lineage to a fixed point: adding a lineage cell can name
    // a parent whose lineage cell must ride too (unless receiver-known).
    // Lineage this store does not hold (foreign rider objects — a rider
    // cache cell's lineage lives at its OWNING scope, never here) is
    // declared receiver-known instead of crashing the transfer — the same
    // rule fanoutCells applies; without it any closure touching a rider
    // residue cell threw E_LINEAGE.
    for (;;) {
      let added = false;
      for (const need of lineageClosureKeys([...cells.values()])) {
        if (cells.has(need) || knownSet.has(need)) continue;
        const cell = store.get(need);
        if (cell) {
          cells.set(need, cell);
          added = true;
        } else {
          knownSet.add(need);
        }
      }
      if (!added) break;
    }
    // Rider residue re-stamp (fix 1): cells this scope committed via
    // ride-along but does not anchor ship as DERIVED — they are a cache
    // of the owner's fact now, and a transfer stamping them authoritative
    // would mint a second authority for the owner's cells (CO2.1).
    // Derived cells are legal transfer content: serializeTransfer checks
    // lineage closure only, and receivers install into derived views
    // (authority stores never install from closures — only /net/adopt and
    // /net/seed feed an authority store).
    const riderCache = this.riderCacheKeys();
    const outCells = [...cells.values()]
      .map((cell) => (riderCache.has(cell.key) ? { ...cell, provenance: "derived" as const } : cell))
      .sort((a, b) => a.key.localeCompare(b.key));
    const transfer = serializeTransfer(outCells, knownSet);
    // CO13: a FULL closure carries the scope's relation rows too. A
    // gateway pull advances its fanout high-water to this head (fix 7),
    // which makes any earlier relation fanout/refan no-op at the
    // receiver — without the rows riding here, a pull would silently
    // starve the mirror of every roster row the superseded fanout
    // carried. Phase 4: `withRelations` extends the same guarantee to a
    // TARGETED pull (the client cold-open backfill), so advancing the
    // high-water on it is equally safe — the roster is coherent at the
    // returned head, and un-pulled cells are absent, not stale. A plain
    // keyed closure (refreshCells repair) still skips them: it never
    // advances the high-water. Sorted for a deterministic transfer.
    const relations =
      wantAll || withRelations
        ? [...seq.relations().values()].sort((a, b) =>
            relationKey(a.relation, a.owner, a.member).localeCompare(relationKey(b.relation, b.owner, b.member))
          )
        : undefined;
    // Phase 0/4 observability: the load gate's cold-open invariant reads
    // this — a targeted cold-open's cells must track the session's needs,
    // never the scope's size.
    this.metric({
      kind: "net_scope_closure_served",
      scope: seq.scope,
      mode: wantAll ? "full" : objects.length > 0 ? "objects" : "keys",
      cells: transfer.cells.length,
      relations: relations?.length ?? 0
    });
    return {
      ...transfer,
      scope: seq.scope,
      head: seq.head(),
      catalog_epoch: seq.catalogEpoch,
      ...(relations !== undefined ? { relations } : {})
    };
  }

  /** Keys in the rider residue ledger (see the constructor comment),
   * memoized in memory (the memo is appended by enqueueDeliveries inside
   * the commit transaction and discarded on abort — fix 3). */
  private riderCacheKeys(): Set<string> {
    if (this.riderCacheMemo === null) {
      this.riderCacheMemo = new Set(
        sqlRows<{ key: string }>(this.state.storage.sql.exec("SELECT key FROM net_scope_rider_cache")).map(
          (row) => row.key
        )
      );
    }
    return this.riderCacheMemo;
  }

  /** CO14 session-ownership witness (see the `owns` wiring comment): the
   * scope holds the session cell AND it is not rider residue. */
  private ownsSessionCell(seq: ScopeSequencer, session: string): boolean {
    const key = cellKey("session", session);
    return seq.store.has(key) && !this.riderCacheKeys().has(key);
  }

  // ---- Fanout + rider adoption (CO2.7, CA3) ---------------------------

  /**
   * Prior observations for the adopt-time CAS (CO2.3 rider integrity).
   * For every cell of a rider-anchored object, record the version the
   * committing turn OBSERVED before writing. Three honest sources, in
   * preference order:
   *
   * (0) the submit's owner attestation covering the cell — the spec's
   *     "the version the committing turn observed" is by definition the
   *     ATTESTED version once CO2.3 rule 1 validates rider reads against
   *     it (on an accepted submit it equals the transcript's rewritten
   *     read version, so this is a provenance clarification for read
   *     cells and the primary source going forward);
   * (a) the transcript's read version for that cell — plan.ts rewrote it
   *     through the gateway view (a derived copy of the OWNER's fact);
   *     the fallback for submits without attestations (direct submits,
   *     single-owner tests);
   * (b) this scope's own pre-commit copy — the residue cache of an
   *     earlier accepted ride-along; the fallback for writes-only riders
   *     that never read the cell this turn. Versions are content
   *     addresses of values (cells.ts cellVersion), so a cached copy of
   *     the owner's value carries the SAME version string the owner
   *     holds, making it directly comparable at the owner.
   *
   * The committing scope's transcript-write `prior` field is NOT usable:
   * it carries engine-recorded versions (plan.ts rewrites reads only),
   * which never compare equal to net content addresses.
   *
   * A cell observed by neither source (a blind "stamp the actor" write,
   * first ride-along) ships no prior: the owner applies it as an
   * owner-ordered blind write — the rider-read-integrity note's design-C
   * allowance, because with no read there is no stale read to launder.
   */
  private captureRiderPriors(
    seq: ScopeSequencer,
    submit: CommitSubmit,
    riderDestinations: RiderDestinations
  ): Map<string, string> {
    const priors = new Map<string, string>();
    const riderObjects = new Set<string>();
    for (const rider of Object.values(riderDestinations)) {
      for (const object of rider.objects) riderObjects.add(object);
    }
    if (riderObjects.size === 0) return priors;
    // Source (0): the owner attestations the turn was validated against.
    // Attestation cell keys are `<kind>:<object>[:<name>]` (object ids
    // never contain ':'); only rider-object cells become priors —
    // attestations may also cover foreign reads of NON-rider objects
    // (read-only foreign state), which adoption never touches.
    for (const entry of Object.values(submit.attestations ?? {})) {
      for (const cell of entry.cells) {
        if (priors.has(cell.key)) continue;
        const object = cell.key.split(":")[1] ?? "";
        if (riderObjects.has(object)) priors.set(cell.key, cell.version);
      }
    }
    for (const read of submit.transcript.reads) {
      if (read.version === undefined) continue; // negative/probe read
      if (!riderObjects.has(read.cell.object)) continue;
      const key = netCellKeyFor(read.cell);
      if (key === null || priors.has(key)) continue;
      priors.set(key, String(read.version));
    }
    for (const key of seq.store.keys()) {
      const cell = seq.store.get(key);
      if (!cell || !riderObjects.has(cell.object) || priors.has(key)) continue;
      priors.set(key, cell.version);
    }
    return priors;
  }

  /**
   * Enqueue the accepted commit's deliveries durably (called inside the
   * submit transaction): a /net/fanout row per registered subscriber
   * (lineage-closed touched closure + the transcript's observations +
   * the commit's LOCAL relation deltas, so subscriber gateways learn
   * rosters push-fashion — CO13), a /net/adopt row per rider scope
   * carrying only the cells anchored to it, and a /net/relate row per
   * foreign relation-owner scope carrying its deltas — the gateway's
   * rider_destinations/relate_destinations name those objects/scopes,
   * because anchor topology is gateway knowledge the sequencer never
   * learns. Adopt rows also carry the per-cell prior versions captured
   * pre-commit (captureRiderPriors) for the owner's CAS, and the shipped
   * rider keys are recorded in the residue ledger (see the constructor
   * comment).
   */
  private enqueueDeliveries(
    seq: ScopeSequencer,
    reply: Extract<CommitReply, { status: "accepted" }>,
    submit: CommitSubmit,
    riderDestinations: RiderDestinations,
    riderPriors: Map<string, string>,
    relateDestinations: RelateDestinations
  ): void {
    const observations = (submit.transcript.observations ?? []) as unknown[];
    const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
      this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
    );
    if (subscribers.length > 0) {
      const cells = this.fanoutCells(seq, reply.touched);
      for (const { destination, delivery_seq } of subscribers) {
        this.persistFanoutRow(destination, delivery_seq, {
          scope: seq.scope,
          seq: reply.head.seq,
          cells,
          observations,
          // Phase 4 item 3: the turn id rides the fanout so receiving
          // gateways can echo-dedupe the SUBMITTING session's push (it
          // already got these observations on the turn reply).
          turn_id: submit.idempotency_key,
          ...(reply.relations && reply.relations.length > 0 ? { relations: reply.relations } : {})
        });
      }
    }
    // CO13: foreign relation deltas go to their owner scopes as durable
    // /relate rows (same transaction as the commit, same at-least-once
    // drain, (from_scope, seq) idempotency at the receiver — the /adopt
    // idioms exactly). The destination comes from the gateway's
    // relate_destinations when named, else the CO15 `scope:<scopeName>`
    // convention (the DO namespace key IS the scope name).
    for (const entry of reply.relations_foreign ?? []) {
      // Client-shell phase i: room-addressed observations RIDE WITH the
      // presence delta to the room's owner. A movement commits at the
      // actor's own authority (B6 — off the room sequencer), so its
      // `left`/`entered` announcements would otherwise fan out only to
      // the committing scope's audience, where nobody is present. The
      // owner applies the delta and refans BOTH to its subscribers under
      // its own head seq — the transition and its announcement arrive as
      // one sequenced event, exactly the v2 affected-scopes delivery.
      const roomObservations = observationsForRelationOwners(observations, entry.deltas);
      this.persistOutboxRow("/relate", relateDestinations[entry.scope]?.destination ?? `scope:${entry.scope}`, {
        scope: seq.scope,
        seq: reply.head.seq,
        cells: [],
        observations: roomObservations,
        relations: entry.deltas
      });
    }
    for (const rider of Object.values(riderDestinations)) {
      const objects = new Set(rider.objects);
      const cells = reply.touched
        .map((key) => seq.store.get(key))
        .filter((cell): cell is Cell => cell !== undefined && objects.has(cell.object));
      if (cells.length === 0) continue;
      // The rider scope anchors these objects, so it definitionally holds
      // their lineage — declare receiver-known rather than reshipping
      // (serializeTransfer still asserts the closure is complete).
      const present = new Set(cells.map((cell) => cell.key));
      const known = new Set([...lineageClosureKeys(cells)].filter((key) => !present.has(key)));
      const transfer = serializeTransfer(
        [...cells].sort((a, b) => a.key.localeCompare(b.key)),
        known
      );
      // Per-cell prior versions for the owner's CAS: only cells with an
      // actual observation carry one (blind writes apply owner-ordered).
      const priorVersions: Record<string, string> = {};
      for (const cell of transfer.cells) {
        const prior = riderPriors.get(cell.key);
        if (prior !== undefined) priorVersions[cell.key] = prior;
      }
      const adoptBody: AdoptOutboxBody = {
        scope: seq.scope,
        seq: reply.head.seq,
        cells: transfer.cells,
        // Observations fan out to subscribers; adoption is cell-only.
        observations: [],
        prior_versions: priorVersions
      };
      this.persistOutboxRow("/adopt", rider.destination, adoptBody);
      // Residue ledger: from now on these keys are a cache of the owner's
      // fact — a later transfer out of this scope ships them derived, and
      // `owns` never claims them (CO14 session witness). The memo append
      // rides the same transaction; discardSeqOnThrow drops it on abort.
      for (const cell of cells) {
        this.state.storage.sql.exec(
          "INSERT INTO net_scope_rider_cache (key) VALUES (?) ON CONFLICT(key) DO NOTHING",
          cell.key
        );
        this.riderCacheMemo?.add(cell.key);
      }
    }
  }

  /**
   * Lineage-closed fanout cell set for the touched keys: lineage present
   * in this scope's store rides along; lineage this scope does not hold
   * (foreign-anchored rider objects — the owner's concern, reached via
   * /net/adopt) is declared receiver-known rather than fabricated. A
   * touched key absent from the store (deleted at this authority) ships
   * nothing — FanoutBody carries installs only (applyFanout semantics).
   */
  private fanoutCells(seq: ScopeSequencer, touched: string[]): Cell[] {
    const cells = new Map<string, Cell>();
    for (const key of touched) {
      const cell = seq.store.get(key);
      if (cell) cells.set(key, cell);
    }
    const known = new Set<string>();
    for (;;) {
      let added = false;
      for (const need of lineageClosureKeys([...cells.values()])) {
        if (cells.has(need) || known.has(need)) continue;
        const cell = seq.store.get(need);
        if (cell) {
          cells.set(need, cell);
          added = true;
        } else {
          known.add(need);
        }
      }
      if (!added) break;
    }
    return serializeTransfer(
      [...cells.values()].sort((a, b) => a.key.localeCompare(b.key)),
      known
    ).cells;
  }

  /** Durable outbox row (mirrors src/net/outbox.ts FanoutRow, plus the
   * route column and the Phase-3 lane/due columns). Same (route,
   * destination, scope, seq) re-enqueued is the same fact — keep the
   * earlier row and its retry state, exactly Outbox.enqueue's rule. */
  /** NC8a: monotonic enqueue counter for the submit metric's
   * outbox_enqueued delta — with the drain metric's delivered/abandoned
   * counts, the report derives outbox DEPTH without a per-pass COUNT
   * scan (which would reintroduce O(backlog) work per drain). */
  private outboxEnqueuedTotal = 0;

  private persistOutboxRow(route: OutboxRoute, destination: string, body: FanoutBody): void {
    this.outboxEnqueuedTotal += 1;
    this.state.storage.sql.exec(
      "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms, scope, seq, next_attempt_at_ms) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, 0) ON CONFLICT(route, id) DO NOTHING",
      route,
      `${destination}/${body.scope}/${body.seq}`,
      destination,
      JSON.stringify(body),
      body.scope,
      body.seq
    );
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO net_scope_outbox_lane (route, destination) VALUES (?, ?)",
      route,
      destination
    );
    // Rows enqueued while a drain is in flight are invisible to its
    // passes; the drain's exit check consumes this flag (fix 4b) so they
    // are picked up before the drain releases.
    if (this.draining) this.enqueuedWhileDraining = true;
  }

  /** Stamp one fanout row with its subscriber-lane position. Authority
   * heads are sparse for a destination: seed, reap, or pre-subscription
   * events can advance a scope without producing a row for that receiver.
   * The per-subscriber counter is therefore the continuity signal, while
   * body.seq remains the authority-state idempotency high-water. Callers
   * already run inside the mutation transaction, so counter + outbox row
   * commit or roll back together. */
  private persistFanoutRow(destination: string, previousDeliverySeq: number, body: FanoutBody): void {
    const deliverySeq = Number(previousDeliverySeq) + 1;
    // The DO is single-threaded and callers run in the authority mutation
    // transaction. Guard the observed value without relying on UPDATE
    // RETURNING, whose cursor behavior differs between workerd and the
    // Node fake.
    this.state.storage.sql.exec(
      "UPDATE net_scope_subscribers SET delivery_seq = ? WHERE destination = ? AND role = 'fanout' AND delivery_seq = ?",
      deliverySeq,
      destination,
      previousDeliverySeq
    );
    this.persistOutboxRow("/fanout", destination, { ...body, delivery_seq: deliverySeq });
  }

  /** Kick a deferred drain when pending rows exist (reactivation path —
   * a scope evicted mid-backoff delivers on its next request). An
   * indexed existence probe, never a backlog count (Phase 3): the cost
   * of this per-request check must not grow with the backlog. */
  private deferPendingDrain(): void {
    const pending = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT EXISTS(SELECT 1 FROM net_scope_outbox WHERE status = 'pending') AS n")
    )[0];
    if (pending && Number(pending.n) > 0) this.host.defer(() => this.drainOutbox());
  }

  /**
   * Drain pending outbox rows. Implementation shape (the step-3 kickoff
   * offers two; this is the documented choice): rows live in SQLite for
   * durability, and each drain rehydrates the pending rows into a fresh
   * src/net Outbox — restoring each row's persisted attempt/backoff
   * state onto the row Outbox minted — then lets Outbox.drain run its
   * lane/backoff/abandon semantics unchanged (at-least-once, per-scope
   * seq order, first failure halts the destination's lane). Outcomes are
   * persisted back in one transaction: delivered rows are deleted
   * (receivers are idempotent by seq — CO2.5 — so a crash between
   * delivery and the delete only causes a harmless redelivery), failed
   * rows keep their attempt count for backoff, abandoned rows stay as
   * named, observable divergence (woo.metric) — never silent loss.
   * /fanout and /adopt drain as separate lanes. Never called on the
   * reply path — only via host.defer and drain-on-reactivation.
   */
  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Post-drain recheck (fix 4b): rows enqueued while a pass was in
      // flight are invisible to that pass AND their enqueue-time defer
      // no-ops on this.draining — without the recheck they would strand
      // until the next request. Loop while a pass delivered something or
      // an enqueue landed mid-drain (the flag is exact: due rows parked
      // behind a mid-backoff lane head are NOT progress and must not
      // spin the loop — their lane's head retry time arms the alarm in
      // the finally below). The pass budget bounds ONE invocation's
      // total work (review #2: unbounded passes let a catch-up backlog
      // consume a whole DO invocation's CPU); leftover DUE work makes
      // outboxNextRetryAt clamp to "now", so the finally's alarm IS the
      // continuation — the next alarm invocation resumes with a fresh
      // budget.
      for (let pass = 1; ; pass += 1) {
        this.enqueuedWhileDraining = false;
        const delivered = await this.drainOutboxPass();
        if (delivered === 0 && !this.enqueuedWhileDraining) break;
        if (pass >= OUTBOX_PASSES_PER_DRAIN) break;
      }
    } finally {
      this.draining = false;
      // Outbox liveness (fix 4a): rows still pending after the drain
      // (failed and waiting out backoff, or due work beyond this
      // invocation's pass budget) arm the DO alarm for their earliest
      // actionable time — a quiet scope with no further requests still
      // delivers when the alarm fires, and a budget-exhausted drain
      // resumes immediately on the alarm's fresh invocation.
      this.armOutboxRetryAlarm();
    }
  }

  /** One drain pass over the route lanes; returns delivered-row count.
   *
   * Bounded (ready-to-scale Phase 3): a pass reads DUE destinations off
   * the (status, next_attempt_at_ms) index — a destination whose rows
   * are all waiting out backoff costs nothing — and per destination a
   * LANE PREFIX of at most OUTBOX_ROWS_PER_LANE rows in (scope, seq)
   * order off the lane index. The prefix deliberately includes a
   * mid-backoff head (Outbox.drain halts the lane on it — CO2.7 order,
   * never skip-ahead), and only ATTEMPTED rows are written back, so a
   * stuck destination's backlog can no longer turn every later request
   * into O(backlog) reads and rewrites — nor starve other destinations,
   * which drain their own lanes in the same pass. Remaining work is
   * picked up by drainOutbox's delivered>0 loop (healthy backlog) or the
   * due-time alarm (failed rows). */
  private async drainOutboxPass(): Promise<number> {
    let deliveredCount = 0;
    const dueAt = this.host.now();
    for (const route of OUTBOX_ROUTES) {
        // Actionable lanes: the directory row exists and the lane HEAD
        // (first pending row in (scope, seq) order — one indexed probe)
        // is due. A lane whose head is mid-backoff is skipped whole: by
        // CO2.7 nothing behind the head may deliver anyway, so reading
        // its rows would be pure waste.
        const lanes: string[] = [];
        for (const lane of this.outboxLanes(route)) {
          if (lanes.length >= OUTBOX_LANES_PER_PASS) break;
          const head = this.outboxLaneHead(route, lane);
          if (head === null) {
            // Emptied (or abandoned-only) lane: prune the directory row.
            this.state.storage.sql.exec(
              "DELETE FROM net_scope_outbox_lane WHERE route = ? AND destination = ?",
              route,
              lane
            );
            continue;
          }
          if (head <= dueAt) lanes.push(lane);
        }
        if (lanes.length === 0) continue;
        const persisted: Array<{
          id: string;
          destination: string;
          body: string;
          attempts: number;
          last_attempt_at_ms: number | null;
        }> = [];
        for (const lane of lanes) {
          persisted.push(
            ...sqlRows<{
              id: string;
              destination: string;
              body: string;
              attempts: number;
              last_attempt_at_ms: number | null;
            }>(
              this.state.storage.sql.exec(
                "SELECT id, destination, body, attempts, last_attempt_at_ms FROM net_scope_outbox WHERE route = ? AND destination = ? AND status = 'pending' ORDER BY scope, seq LIMIT ?",
                route,
                lane,
                OUTBOX_ROWS_PER_LANE
              )
            )
          );
        }
        if (persisted.length === 0) continue;
        // Backoff injected explicitly so it stays in lockstep with the
        // alarm's retry-time computation (see OUTBOX_BACKOFF_MS).
        const outbox = new Outbox({ backoffMs: OUTBOX_BACKOFF_MS });
        const rows: FanoutRow[] = [];
        for (const p of persisted) {
          const row = outbox.enqueue(p.destination, JSON.parse(p.body) as FanoutBody);
          // Rehydrate retry state: enqueue mints a fresh row; restore the
          // persisted attempts/backoff so semantics match the in-memory
          // outbox exactly (a row mid-backoff stays mid-backoff).
          row.attempts = Number(p.attempts);
          row.last_attempt_at_ms = p.last_attempt_at_ms === null ? null : Number(p.last_attempt_at_ms);
          rows.push(row);
        }
        // Capture per-row delivery errors: Outbox.drain records failure by
        // status alone, so without this a row retries silently for the
        // whole attempt budget — an unobservable failure window ("no
        // silent caps"). The error surfaces on the failed row's metric
        // below on EVERY failed attempt, not only at abandonment.
        const deliveryErrors = new Map<string, string>();
        const drained = await outbox.drain(this.host.now(), async (row) => {
          try {
            if (route === "/adopt") {
              const adoptBody = row.body as AdoptOutboxBody;
              await this.host.rpc(row.destination, "/adopt", {
                from_scope: adoptBody.scope,
                seq: adoptBody.seq,
                cells: adoptBody.cells,
                // The pre-commit observations for the owner's CAS (fix 1).
                ...(adoptBody.prior_versions !== undefined ? { prior_versions: adoptBody.prior_versions } : {})
              });
            } else if (route === "/relate") {
              // CO13: the row's FanoutBody carries the deltas; the wire
              // shape is (from_scope, seq, deltas[, observations]) — the
              // receiver's idempotency key plus its application input.
              // Observations (phase i): the room-addressed announcements
              // riding with the presence delta (see enqueueDeliveries).
              await this.host.rpc(row.destination, "/relate", {
                from_scope: row.body.scope,
                seq: row.body.seq,
                deltas: row.body.relations ?? [],
                ...(row.body.observations.length > 0 ? { observations: row.body.observations } : {})
              });
            } else if (route === "/plan-scheduled") {
              // CO16: deliver the scheduled turn to the planner gateway,
              // which runs the normal turn machinery under the stable
              // `sched:<id>:<at_logical_time>` idempotency key. A 200
              // (any TurnResult, accepted or terminal-rejected) deletes
              // the row below: at-least-once delivery + the committing
              // scope's reply cache = fired exactly once, and a terminal
              // verdict will not change on redelivery. A thrown rpc
              // (planner down, E_BUDGET 400) retries on the lane's
              // backoff and abandons as the named divergence.
              const schedBody = row.body as PlanScheduledOutboxBody;
              await this.host.rpc(row.destination, "/plan-scheduled", {
                scheduled_turn: schedBody.scheduled_turn,
                scope: schedBody.scope,
                catalog_epoch: schedBody.catalog_epoch
              });
            } else {
              await this.host.rpc(row.destination, "/fanout", row.body);
            }
          } catch (err) {
            deliveryErrors.set(row.id, String(err));
            throw err;
          }
        });
        deliveredCount += drained.delivered.length;
        for (const failedId of drained.failed) {
          this.metric({
            kind: "net_scope_outbox_delivery_failed",
            route,
            id: failedId,
            status: "error",
            error: deliveryErrors.get(failedId) ?? "unknown"
          });
        }
        // Write back ONLY the rows this pass attempted (Phase 3): a row
        // skipped for backoff is byte-identical in storage — rewriting it
        // would make every pass O(batch) writes regardless of progress.
        const touched = new Set([...drained.delivered, ...drained.failed, ...drained.abandoned]);
        let abandonedCount = 0;
        this.state.storage.transactionSync(() => {
          for (const row of rows) {
            if (!touched.has(row.id)) continue;
            if (row.status === "delivered") {
              this.state.storage.sql.exec("DELETE FROM net_scope_outbox WHERE route = ? AND id = ?", route, row.id);
            } else {
              // last_attempt_at_ms was just stamped by the attempt, so the
              // due-time lands exactly where Outbox.drain's skip window and
              // outboxNextRetryAt expect it (one backoff formula, three
              // readers).
              const nextAttemptAt = Number(row.last_attempt_at_ms) + OUTBOX_BACKOFF_MS(row.attempts);
              this.state.storage.sql.exec(
                "UPDATE net_scope_outbox SET status = ?, attempts = ?, last_attempt_at_ms = ?, next_attempt_at_ms = ? WHERE route = ? AND id = ?",
                row.status,
                row.attempts,
                row.last_attempt_at_ms,
                nextAttemptAt,
                route,
                row.id
              );
              if (row.status === "abandoned") {
                abandonedCount += 1;
                this.metric({
                  kind: "net_scope_outbox_abandoned",
                  route,
                  id: row.id,
                  destination: row.destination,
                  status: "error",
                  error: "E_OUTBOX_ABANDONED",
                  attempts: row.attempts
                });
              }
            }
          }
          if (abandonedCount > 0) {
            // Bounded abandoned retention: each abandonment already emitted
            // its named divergence metric above; the rows are kept only as
            // a debugging tail. Unbounded retention would be a storage leak
            // scaling with a dead subscriber's lifetime (the small-world
            // assumption Phase 3 removes).
            this.state.storage.sql.exec(
              "DELETE FROM net_scope_outbox WHERE status = 'abandoned' AND rowid NOT IN (SELECT rowid FROM net_scope_outbox WHERE status = 'abandoned' ORDER BY rowid DESC LIMIT ?)",
              OUTBOX_ABANDONED_KEEP
            );
          }
          // Prune emptied lanes from the directory (one EXISTS probe per
          // lane this pass touched — a lane row must vanish when its last
          // pending row does, or the directory grows with dead
          // destinations forever).
          for (const lane of lanes) {
            const remains = sqlRows<{ n: number }>(
              this.state.storage.sql.exec(
                "SELECT EXISTS(SELECT 1 FROM net_scope_outbox WHERE route = ? AND destination = ? AND status = 'pending') AS n",
                route,
                lane
              )
            )[0];
            if (!remains || Number(remains.n) === 0) {
              this.state.storage.sql.exec(
                "DELETE FROM net_scope_outbox_lane WHERE route = ? AND destination = ?",
                route,
                lane
              );
            }
          }
        });
        // Phase 0/CO10 observability for the Phase-3 invariant: rows a
        // pass considered must stay bounded as the backlog grows (the
        // load gate asserts against this).
        this.metric({
          kind: "net_scope_outbox_drain_pass",
          route,
          considered: persisted.length,
          delivered: drained.delivered.length,
          failed: drained.failed.length,
          abandoned: drained.abandoned.length,
          skipped_backoff: drained.skipped_backoff.length
        });
    }
    return deliveredCount;
  }

  /** The route's lane directory (Phase 3): every destination that may
   * hold pending rows — O(active lanes), independent of backlog depth. */
  private outboxLanes(route: OutboxRoute): string[] {
    return sqlRows<{ destination: string }>(
      this.state.storage.sql.exec(
        "SELECT destination FROM net_scope_outbox_lane WHERE route = ? ORDER BY destination",
        route
      )
    ).map((row) => row.destination);
  }

  /** The lane HEAD's due-time: the first pending row in (scope, seq)
   * order — one probe off the lane index. Null when the lane holds no
   * pending rows (directory row is prunable). The head's due-time IS the
   * lane's actionable time: CO2.7 forbids anything behind it delivering
   * first, so rows further back are irrelevant to scheduling. */
  private outboxLaneHead(route: OutboxRoute, destination: string): number | null {
    const rows = sqlRows<{ at: number | null }>(
      this.state.storage.sql.exec(
        "SELECT next_attempt_at_ms AS at FROM net_scope_outbox WHERE route = ? AND destination = ? AND status = 'pending' ORDER BY scope, seq LIMIT 1",
        route,
        destination
      )
    );
    return rows.length > 0 && rows[0].at !== null ? Number(rows[0].at) : null;
  }

  /**
   * Earliest wall-clock time a pending outbox row becomes ACTIONABLE:
   * the minimum over lane heads (Phase 3 — O(active lanes) probes, never
   * a read of every pending row). Per-lane heads, not a global MIN over
   * rows: a due row parked behind a mid-backoff head is not actionable,
   * and counting it would arm an immediate alarm that a bounded pass can
   * do nothing with — an alarm-driven busy loop. Clamped to now so the
   * alarm never arms in the past. Null when nothing is pending.
   */
  private outboxNextRetryAt(): number | null {
    let earliest: number | null = null;
    for (const route of OUTBOX_ROUTES) {
      for (const lane of this.outboxLanes(route)) {
        const head = this.outboxLaneHead(route, lane);
        if (head !== null && (earliest === null || head < earliest)) earliest = head;
      }
    }
    return earliest === null ? null : Math.max(earliest, this.host.now());
  }

  /**
   * Arm (or clear) the outbox retry wake-up (fix 4a). Uses its own
   * WorkerdHost alarm key so the storage alarm lands on the earlier of
   * the scheduled-turn wake and the outbox retry. The clear only runs
   * when THIS lifetime armed the key: after eviction the flag resets,
   * and a stale storage alarm simply fires alarm(), which re-derives
   * everything from durable state and no-ops harmlessly.
   */
  private armOutboxRetryAlarm(): void {
    const at = this.outboxNextRetryAt();
    if (at !== null) {
      this.outboxAlarmArmed = true;
      this.host.setAlarm(OUTBOX_ALARM_KEY, at, async () => {
        // Durable wake path is the DO's alarm() handler (see rearmAlarm).
      });
    } else if (this.outboxAlarmArmed) {
      this.outboxAlarmArmed = false;
      this.host.setAlarm(OUTBOX_ALARM_KEY, null, async () => {});
    }
  }

  /**
   * CA3 rider adoption (CO2.3 rider integrity, rule 2): cells this scope
   * anchors that were committed via ride-along at another scope are
   * applied as an OWNER-SEQUENCED commit — ScopeSequencer.adopt CASes
   * each cell against the prior version the committing turn observed
   * (the attested version for attested cells; captureRiderPriors at the
   * sender), advances this scope's head ONCE for the applied batch, and
   * stamps the adopted cells with the new head (CO8-correct stamps —
   * observers and catch-up see a real owner-head advance).
   *
   * Conflicts are owner-wins and surface as net_adopt_conflict metrics
   * (named, counted — never a silent lost update, CO6). The committing
   * scope's transcript already embedded the stale value in its
   * post-state; that residual tear is the spec's named, bounded
   * inconsistency — healed by the next read-version repair on the cell,
   * eliminated structurally by CA10 route migration.
   *
   * After a non-empty apply, the adopted cells fan out to THIS scope's
   * own subscribers through the durable outbox — the owner's observers
   * learn of adopted changes exactly like any owner commit (the catch-up
   * gap the 2026-07-06 review named). The enqueue shares the adoption's
   * transaction, so a crash cannot separate the owner commit from its
   * fanout rows (CO2.7).
   *
   * Idempotent by the (from_scope, seq) high-water, which advances even
   * on an all-conflict or terminally rejected adoption: the fact WAS
   * processed; redelivery must not flap the verdict or retry forever.
   */
  private adopt(body: {
    from_scope: string;
    seq: number;
    cells: Cell[];
    prior_versions?: Record<string, string>;
  }): {
    applied: boolean;
    installed: number;
    conflicts: number;
    head: ScopeHead;
    rejected?: { reason: "catalog_mutation"; detail: Record<string, unknown> };
  } {
    const seq = this.ensureSequencer();
    return this.discardSeqOnThrow(() => this.store.transaction(() => {
      const rows = sqlRows<{ seq: number }>(
        this.state.storage.sql.exec("SELECT seq FROM net_scope_adopted WHERE from_scope = ?", body.from_scope)
      );
      const last = rows.length > 0 ? Number(rows[0].seq) : 0;
      if (body.seq <= last) return { applied: false, installed: 0, conflicts: 0, head: seq.head() };
      const result = seq.adopt({
        from_scope: body.from_scope,
        seq: body.seq,
        cells: body.cells,
        priors: body.prior_versions ?? {}
      });
      if (result.status === "rejected") {
        // Terminal owner refusal: acknowledge this delivery by advancing the
        // sender high-water below, but install nothing. Returning 200 with a
        // structured refusal keeps the durable sender outbox from retrying a
        // definition write that can never become valid under this epoch.
        this.metric({
          kind: "net_adopt_rejected",
          scope: seq.scope,
          from_scope: body.from_scope,
          seq: body.seq,
          reason: result.reason,
          ...(result.detail ?? {})
        });
      }
      for (const conflict of result.conflicts) {
        this.metric({
          kind: "net_adopt_conflict",
          scope: seq.scope,
          from_scope: body.from_scope,
          seq: body.seq,
          key: conflict.key,
          ours: conflict.ours,
          theirs: conflict.theirs
        });
      }
      if (result.status === "applied") {
        // Owner-observer fanout: subscribers receive the adopted cells at
        // the advanced head exactly like a submit's fanout (lineage-
        // closed). Adoption carries no observations of its own — the
        // committing scope's fanout already delivered the turn's
        // observations to ITS subscribers; this delivers the owner's
        // authoritative cell state.
        const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
          this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
        );
        if (subscribers.length > 0) {
          const cells = this.fanoutCells(seq, result.applied);
          for (const { destination, delivery_seq } of subscribers) {
            this.persistFanoutRow(destination, delivery_seq, {
              scope: seq.scope,
              seq: result.head.seq,
              cells,
              observations: []
            });
          }
        }
      }
      this.state.storage.sql.exec(
        "INSERT INTO net_scope_adopted (from_scope, seq) VALUES (?, ?) ON CONFLICT(from_scope) DO UPDATE SET seq = excluded.seq",
        body.from_scope,
        body.seq
      );
      return {
        applied: result.status !== "rejected",
        installed: result.applied.length,
        conflicts: result.conflicts.length,
        head: result.head,
        ...(result.status === "rejected"
          ? { rejected: { reason: result.reason as "catalog_mutation", detail: result.detail ?? {} } }
          : {})
      };
    }));
  }

  /**
   * CO13 relation delivery: deltas derived at ANOTHER scope whose owner
   * objects anchor here, applied to this scope's relation family as an
   * owner-sequenced event (ScopeSequencer.applyForeignRelationDeltas
   * advances the head once per non-empty batch — see its doc for why the
   * refan needs a real seq), then REFANNED to this scope's own fanout
   * subscribers so their gateways learn the roster change push-fashion.
   *
   * Mirrors adopt() exactly: the application, the refan enqueue, and the
   * (from_scope, seq) high-water advance share ONE transaction, so a
   * crash cannot separate the applied rows from their fanout (CO2.7) and
   * redelivery no-ops (CO2.5). The high-water advances even when every
   * delta was a no-op (`empty`): the fact WAS processed; redelivery must
   * not flap the verdict.
   */
  private relate(body: {
    from_scope: string;
    seq: number;
    deltas: RelationDelta[];
    observations?: unknown[];
  }): { applied: boolean; changed: number; head: ScopeHead } {
    const seq = this.ensureSequencer();
    return this.discardSeqOnThrow(() => this.store.transaction(() => {
      const rows = sqlRows<{ seq: number }>(
        this.state.storage.sql.exec("SELECT seq FROM net_scope_related WHERE from_scope = ?", body.from_scope)
      );
      const last = rows.length > 0 ? Number(rows[0].seq) : 0;
      if (body.seq <= last) return { applied: false, changed: 0, head: seq.head() };
      const result = seq.applyForeignRelationDeltas(body.deltas, { from_scope: body.from_scope, seq: body.seq });
      if (result.status === "applied") {
        // Refan exactly the deltas that changed this family (an add of an
        // identical row / remove of an absent row carries no news) at the
        // ADVANCED head — subscriber gateways gate by per-scope seq.
        const changed = new Set(result.changed);
        const applied = body.deltas.filter((delta) =>
          changed.has(relationKey(delta.row.relation, delta.row.owner, delta.row.member))
        );
        const subscribers = sqlRows<{ destination: string; delivery_seq: number }>(
          this.state.storage.sql.exec("SELECT destination, delivery_seq FROM net_scope_subscribers WHERE role = 'fanout'")
        );
        for (const { destination, delivery_seq } of subscribers) {
          this.persistFanoutRow(destination, delivery_seq, {
            scope: seq.scope,
            seq: result.head.seq,
            cells: [],
            // Phase i: the room-addressed announcements that rode with
            // the presence delta refan under THIS scope's head seq, so
            // occupants receive the transition and its announcement as
            // one sequenced event. Redelivered relates no-op above, so
            // the push stays at-most-once.
            observations: body.observations ?? [],
            relations: applied
          });
        }
      }
      this.state.storage.sql.exec(
        "INSERT INTO net_scope_related (from_scope, seq) VALUES (?, ?) ON CONFLICT(from_scope) DO UPDATE SET seq = excluded.seq",
        body.from_scope,
        body.seq
      );
      return { applied: result.status === "applied", changed: result.changed.length, head: result.head };
    }));
  }

  /**
   * Memory-follows-durable (fix 3): the in-memory sequencer mutates
   * inside the callback (submit/seed/schedule/adopt), so if the durable
   * transaction then aborts, memory is AHEAD of SQLite — an idempotent
   * replay would find a phantom recorded reply and never re-commit. On
   * ANY throw, discard the sequencer; the next request rehydrates it
   * from the (rolled-back) durable store and re-validates fresh.
   */
  private discardSeqOnThrow<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      this.seq = null;
      // The rider-residue memo may have been appended inside the aborted
      // transaction (enqueueDeliveries) — rehydrate it from the rolled-
      // back ledger alongside the sequencer.
      this.riderCacheMemo = null;
      throw err;
    }
  }

  /** Always re-derive the wake-up from DURABLE scope state (never from
   * memory). Two keys feed the single storage alarm (WorkerdHost keeps
   * the earliest): the scheduled-turn wake and the outbox retry (fix
   * 4a). Only FUTURE turns arm the clock (fix 8a): an overdue row still
   * in the scheduled family means no planner was registered when it
   * fired (CO16's parked state — it dispatches on the first alarm after
   * a planner subscribes, or on the next future turn's wake); arming for
   * it would fire the alarm in a tight loop that can do no useful work.
   * Dispatched rows live in the outbox family, whose retry alarm covers
   * them. */
  private rearmAlarm(now: number, opts?: { dueNow?: boolean }): void {
    // One indexed MIN over due_at (Phase 3) — re-arming must not read and
    // parse every parked row. `dueNow` is the alarm handler's bounded-
    // batch continuation: more turns are due right now and a planner can
    // execute them, so wake immediately instead of at the next future one.
    const nextFuture = opts?.dueNow ? now : this.store.nextScheduledAfter(now);
    this.host.setAlarm(SCOPE_ALARM_KEY, nextFuture, async () => {
      // The durable wake path is alarm() above; this callback exists to
      // satisfy the Host contract and is not retained by WorkerdHost.
    });
    this.armOutboxRetryAlarm();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
