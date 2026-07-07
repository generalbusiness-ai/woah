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
 *       POST /net/attest    {keys} → {scope, owner_head, cells:
 *                           [{key, version}]} — the CO2.3 rider-read
 *                           attestation surface: the gateway fetches
 *                           this from each owner scope at plan time so
 *                           the committing scope can validate foreign
 *                           reads (absent cells attest "absent")
 *       POST /net/closure   {keys, known?} → lineage-closed CellTransfer
 *       GET  /net/head      {scope, catalog_epoch, head}
 *       POST /net/seed      bootstrap/install path (also how tests build
 *                           a scope; the catalog install pipeline adopts
 *                           it in a later step)
 *       POST /net/subscribe {destination} → register a fanout receiver
 *                           (a gateway shard; maintained on session open)
 *       POST /net/adopt     {from_scope, seq, cells, prior_versions?} →
 *                           CA3 rider adoption as an OWNER-SEQUENCED
 *                           commit (CO2.3): per-cell prior-version CAS,
 *                           head advances once per applied batch, and
 *                           the adopted cells fan out to this scope's
 *                           own subscribers; idempotent by (from_scope,
 *                           seq)
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
 *   - the alarm() wake path: pop due turns, emit a woo.metric line per
 *     fired turn (planning a scheduled turn arrives with the gateway
 *     machinery), and ALWAYS re-arm from nextAlarmAt() — the queue is
 *     scope state, so a parked task survives eviction (CO2.8).
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
import { authorizeSessionSubmit } from "../../net/sessions";
import { relationKey, type RelationDelta, type RelationRow } from "../../net/relations";
import type { ScopeMeta, ScopeStore, TailEntry } from "../../net/scope-store";
import type { CommitReply } from "../../net/scope";
import { netCellKeyFor } from "../../net/transcript";
import { verifyInternalRequest } from "../internal-auth";
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

/** The three outbox delivery surfaces. They drain as separate lanes so a
 * destination carrying several cannot collide row ids, and adoption/
 * relation delivery cannot be held behind a slow subscriber (or vice
 * versa). */
type OutboxRoute = "/fanout" | "/adopt" | "/relate";

/** The /adopt outbox body: FanoutBody plus the per-cell prior versions
 * the committing turn observed (the rider-read integrity interim guard —
 * notes/2026-07-06-rider-read-integrity.md). Extra field only; the
 * src/net/outbox.ts FanoutBody type stays unchanged (Outbox carries the
 * body opaquely and the JSON round-trip through net_scope_outbox keeps
 * the field). */
type AdoptOutboxBody = FanoutBody & { prior_versions?: Record<string, string> };

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
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_reply (idempotency_key TEXT PRIMARY KEY, body TEXT NOT NULL)"
    );
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_tail (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_scope_scheduled (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
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
      "INSERT INTO net_scope_scheduled (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      turn.id,
      JSON.stringify(turn)
    );
  }

  deleteScheduled(id: string): void {
    this.storage.sql.exec("DELETE FROM net_scope_scheduled WHERE id = ?", id);
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

/** Mirror of src/net/outbox.ts's default backoff, passed INTO the Outbox
 * at drain time so the drain's skip-window and the alarm's retry-time
 * computation (outboxNextRetryAt) can never drift apart. */
const OUTBOX_BACKOFF_MS = (attempt: number): number => Math.min(30_000, 250 * 2 ** (attempt - 1));

export class NetScopeDO {
  private readonly store: SqliteScopeStore;
  private readonly host: WorkerdHost;
  private seq: ScopeSequencer | null = null;
  /** One drain at a time; a re-kick while draining is dropped (the next
   * request or defer re-kicks — rows are durable, nothing is lost). */
  private draining = false;
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
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_subscribers (destination TEXT PRIMARY KEY)"
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_scope_outbox (route TEXT NOT NULL, id TEXT NOT NULL, destination TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt_at_ms INTEGER, PRIMARY KEY (route, id))"
    );
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
    this.host = new WorkerdHost({
      resolve: (destination) => resolveNetDestination(this.env, destination),
      env,
      waitUntil: state.waitUntil?.bind(state),
      alarmStorage: state.storage
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(this.env, request);
    } catch (err) {
      return json({ error: String(err) }, 401);
    }
    // Drain-on-reactivation (CO2.7 at-least-once): pending outbox rows
    // left by a crash or delivery fault go out on the next wake — any
    // authenticated request suffices to kick the deferred drain.
    this.deferPendingDrain();
    const url = new URL(request.url);
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
        const seq = this.ensureSequencer(submit.scope, submit.stamp.catalog_epoch);
        const headBefore = seq.head().seq;
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
        for (const [scope, entry] of Object.entries(relateDestinations)) {
          for (const object of entry.objects) this.relateScopeHints.set(object, scope);
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
        }
        this.host.defer(() => this.drainOutbox());
        return json(reply);
      }
      if (request.method === "POST" && url.pathname === "/net/subscribe") {
        const body = (await request.json()) as { destination?: string };
        if (!body.destination) throw new Error("subscribe requires a destination");
        this.state.storage.sql.exec(
          "INSERT INTO net_scope_subscribers (destination) VALUES (?) ON CONFLICT(destination) DO NOTHING",
          body.destination
        );
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
        // A non-empty adoption enqueued fanout rows to this scope's own
        // subscribers (owner-sequenced commit — see adopt()); drain them
        // off the reply path, same as /net/submit.
        this.host.defer(() => this.drainOutbox());
        return json(adopted);
      }
      if (request.method === "POST" && url.pathname === "/net/relate") {
        const body = (await request.json()) as {
          from_scope: string;
          seq: number;
          deltas: RelationDelta[];
        };
        const related = this.relate(body);
        // A non-empty application enqueued refan rows to this scope's own
        // subscribers (see relate()); drain them off the reply path.
        this.host.defer(() => this.drainOutbox());
        return json(related);
      }
      if (request.method === "POST" && url.pathname === "/net/attest") {
        // CO2.3 rider-read attestation: report this authority's current
        // version for each requested cell key, plus the head the report
        // was taken at. Absent cells attest "absent" — the same token
        // read-version validation uses, so an attested absence compares
        // directly against a planned "absent" read. Read-only: no state
        // changes, no head movement.
        const body = (await request.json()) as { keys: string[] };
        const seq = this.ensureSequencer();
        return json({
          scope: seq.scope,
          owner_head: seq.head(),
          cells: body.keys.map((key) => ({ key, version: seq.store.get(key)?.version ?? "absent" }))
        });
      }
      if (request.method === "POST" && url.pathname === "/net/closure") {
        const body = (await request.json()) as { keys: string[]; known?: string[] };
        return json(this.closure(body.keys, body.known ?? []));
      }
      if (request.method === "GET" && url.pathname === "/net/head") {
        const seq = this.ensureSequencer();
        return json({ scope: seq.scope, catalog_epoch: seq.catalogEpoch, head: seq.head() });
      }
      if (request.method === "POST" && url.pathname === "/net/seed") {
        const body = (await request.json()) as {
          scope: string;
          catalog_epoch: string;
          cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>;
        };
        const seq = this.ensureSequencer(body.scope, body.catalog_epoch);
        this.discardSeqOnThrow(() => seq.seed(body.cells));
        return json({ ok: true, scope: seq.scope, head: seq.head() });
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
   * DO alarm wake (CO2.8). The sequencer rehydrates from durable state —
   * in-memory callbacks never survive eviction, which is exactly why the
   * durable path re-derives everything here. Phase 3 only OBSERVES fired
   * turns (a woo.metric line each, rows left parked — fix 8a);
   * planning/submitting the scheduled turn arrives with the Phase-3.5
   * executor. Re-arming considers future turns and outbox retries.
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
    // Fix 8a: PEEK, never pop. The executor that could actually run
    // these turns lands in Phase 3.5; destructively popping them here
    // would delete parked work the wake-up cannot execute (CO2.8 broken
    // silently). Each due turn logs once per alarm-firing with a note;
    // the rows stay parked, and the re-arm below considers only FUTURE
    // turns so overdue rows cannot spin the alarm in a tight loop.
    for (const turn of seq.peekDue(now)) {
      console.log(
        "woo.metric",
        JSON.stringify({
          kind: "net_scope_scheduled_turn_fired",
          scope: seq.scope,
          id: turn.id,
          at_logical_time: turn.at_logical_time,
          fired_at: now,
          note: "parked: turn executor lands in Phase 3.5; row retained",
          ts: Date.now()
        })
      );
    }
    this.rearmAlarm(now);
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
          now: () => this.host.now()
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
      scopeOf: (object) => this.relateScopeHints.get(object) ?? seq.scope
    });
    this.seq = seq;
    return this.seq;
  }

  /**
   * Lineage-closed transfer for the requested keys (`keys: ["*"]` = the
   * full scope cell set — the CO7 cold-open/state-transfer case; scopes
   * are room-sized by design, which is what keeps "*" bounded).
   * Requested keys always ship when present; `known` only relieves the
   * lineage-closure requirement (how transfers stay small without
   * reshipping the class chain — CO7). A requested key that is absent
   * ships nothing: at the receiver, absence after an accepted commit
   * means the cell was deleted.
   */
  private closure(keys: string[], known: string[]): CellTransfer & { scope: string; head: ScopeHead; catalog_epoch: string } {
    const seq = this.ensureSequencer();
    const store = seq.store;
    const wantAll = keys.length === 1 && keys[0] === "*";
    const cells = new Map<string, Cell>();
    const requested = wantAll ? [...store.keys()] : keys;
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
    return { ...transfer, scope: seq.scope, head: seq.head(), catalog_epoch: seq.catalogEpoch };
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
    const subscribers = sqlRows<{ destination: string }>(
      this.state.storage.sql.exec("SELECT destination FROM net_scope_subscribers")
    );
    if (subscribers.length > 0) {
      const cells = this.fanoutCells(seq, reply.touched);
      for (const { destination } of subscribers) {
        this.persistOutboxRow("/fanout", destination, {
          scope: seq.scope,
          seq: reply.head.seq,
          cells,
          observations,
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
      this.persistOutboxRow("/relate", relateDestinations[entry.scope]?.destination ?? `scope:${entry.scope}`, {
        scope: seq.scope,
        seq: reply.head.seq,
        cells: [],
        observations: [],
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
   * route column). Same (route, destination, scope, seq) re-enqueued is
   * the same fact — keep the earlier row and its retry state, exactly
   * Outbox.enqueue's rule. */
  private persistOutboxRow(route: OutboxRoute, destination: string, body: FanoutBody): void {
    this.state.storage.sql.exec(
      "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms) VALUES (?, ?, ?, ?, 'pending', 0, NULL) ON CONFLICT(route, id) DO NOTHING",
      route,
      `${destination}/${body.scope}/${body.seq}`,
      destination,
      JSON.stringify(body)
    );
  }

  /** Kick a deferred drain when pending rows exist (reactivation path —
   * a scope evicted mid-backoff delivers on its next request). */
  private deferPendingDrain(): void {
    const pending = sqlRows<{ n: number }>(
      this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_outbox WHERE status = 'pending'")
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
      // fresh (never-attempted) pending rows appeared; a fresh row is
      // attempted by the very next pass (its attempts becomes >= 1), so
      // the loop is bounded even when every delivery fails.
      for (;;) {
        const delivered = await this.drainOutboxPass();
        if (delivered > 0) continue;
        const fresh = sqlRows<{ n: number }>(
          this.state.storage.sql.exec(
            "SELECT COUNT(*) AS n FROM net_scope_outbox WHERE status = 'pending' AND attempts = 0"
          )
        )[0];
        if (!fresh || Number(fresh.n) === 0) break;
      }
    } finally {
      this.draining = false;
      // Outbox liveness (fix 4a): rows still pending after the drain
      // (failed, waiting out backoff) arm the DO alarm for their
      // earliest retry time, so a quiet scope with no further requests
      // still delivers when the alarm fires.
      this.armOutboxRetryAlarm();
    }
  }

  /** One drain pass over the route lanes; returns delivered-row count. */
  private async drainOutboxPass(): Promise<number> {
    let deliveredCount = 0;
    for (const route of ["/fanout", "/adopt", "/relate"] as const) {
        const persisted = sqlRows<{
          id: string;
          destination: string;
          body: string;
          attempts: number;
          last_attempt_at_ms: number | null;
        }>(
          this.state.storage.sql.exec(
            "SELECT id, destination, body, attempts, last_attempt_at_ms FROM net_scope_outbox WHERE route = ? AND status = 'pending'",
            route
          )
        );
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
              // shape is (from_scope, seq, deltas) — the receiver's
              // idempotency key plus its application input.
              await this.host.rpc(row.destination, "/relate", {
                from_scope: row.body.scope,
                seq: row.body.seq,
                deltas: row.body.relations ?? []
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
          console.log(
            "woo.metric",
            JSON.stringify({
              kind: "net_scope_outbox_delivery_failed",
              route,
              id: failedId,
              error: deliveryErrors.get(failedId) ?? "unknown",
              ts: Date.now()
            })
          );
        }
        this.state.storage.transactionSync(() => {
          for (const row of rows) {
            if (row.status === "delivered") {
              this.state.storage.sql.exec("DELETE FROM net_scope_outbox WHERE route = ? AND id = ?", route, row.id);
            } else {
              this.state.storage.sql.exec(
                "UPDATE net_scope_outbox SET status = ?, attempts = ?, last_attempt_at_ms = ? WHERE route = ? AND id = ?",
                row.status,
                row.attempts,
                row.last_attempt_at_ms,
                route,
                row.id
              );
              if (row.status === "abandoned") {
                console.log(
                  "woo.metric",
                  JSON.stringify({
                    kind: "net_scope_outbox_abandoned",
                    route,
                    id: row.id,
                    destination: row.destination,
                    attempts: row.attempts,
                    ts: Date.now()
                  })
                );
              }
            }
          }
        });
    }
    return deliveredCount;
  }

  /**
   * Earliest wall-clock time a pending outbox row becomes retryable
   * (last_attempt_at_ms + backoff(attempts); a never-attempted row is
   * due immediately). Null when nothing is pending.
   */
  private outboxNextRetryAt(): number | null {
    const rows = sqlRows<{ attempts: number; last_attempt_at_ms: number | null }>(
      this.state.storage.sql.exec(
        "SELECT attempts, last_attempt_at_ms FROM net_scope_outbox WHERE status = 'pending'"
      )
    );
    let earliest: number | null = null;
    for (const row of rows) {
      const at =
        row.last_attempt_at_ms === null
          ? this.host.now()
          : Number(row.last_attempt_at_ms) + OUTBOX_BACKOFF_MS(Number(row.attempts));
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
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
   * on an all-conflict adoption: the fact WAS processed; redelivery must
   * not flap the verdict.
   */
  private adopt(body: {
    from_scope: string;
    seq: number;
    cells: Cell[];
    prior_versions?: Record<string, string>;
  }): { applied: boolean; installed: number; conflicts: number; head: ScopeHead } {
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
      for (const conflict of result.conflicts) {
        console.log(
          "woo.metric",
          JSON.stringify({
            kind: "net_adopt_conflict",
            scope: seq.scope,
            from_scope: body.from_scope,
            seq: body.seq,
            key: conflict.key,
            ours: conflict.ours,
            theirs: conflict.theirs,
            ts: Date.now()
          })
        );
      }
      if (result.status === "applied") {
        // Owner-observer fanout: subscribers receive the adopted cells at
        // the advanced head exactly like a submit's fanout (lineage-
        // closed). Adoption carries no observations of its own — the
        // committing scope's fanout already delivered the turn's
        // observations to ITS subscribers; this delivers the owner's
        // authoritative cell state.
        const subscribers = sqlRows<{ destination: string }>(
          this.state.storage.sql.exec("SELECT destination FROM net_scope_subscribers")
        );
        if (subscribers.length > 0) {
          const cells = this.fanoutCells(seq, result.applied);
          for (const { destination } of subscribers) {
            this.persistOutboxRow("/fanout", destination, {
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
      return { applied: true, installed: result.applied.length, conflicts: result.conflicts.length, head: result.head };
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
        const subscribers = sqlRows<{ destination: string }>(
          this.state.storage.sql.exec("SELECT destination FROM net_scope_subscribers")
        );
        for (const { destination } of subscribers) {
          this.persistOutboxRow("/fanout", destination, {
            scope: seq.scope,
            seq: result.head.seq,
            cells: [],
            observations: [],
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
   * 4a). Only FUTURE turns arm the clock (fix 8a): overdue rows are
   * parked observations until the Phase-3.5 executor drains them —
   * arming for them would fire the alarm in a tight loop that can do
   * no useful work. */
  private rearmAlarm(now: number): void {
    let nextFuture: number | null = null;
    for (const turn of this.store.readScheduled()) {
      if (turn.at_logical_time > now && (nextFuture === null || turn.at_logical_time < nextFuture)) {
        nextFuture = turn.at_logical_time;
      }
    }
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
