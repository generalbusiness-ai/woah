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
 *       POST /net/closure   {keys, known?} → lineage-closed CellTransfer
 *       GET  /net/head      {scope, catalog_epoch, head}
 *       POST /net/seed      bootstrap/install path (also how tests build
 *                           a scope; the catalog install pipeline adopts
 *                           it in a later step)
 *       POST /net/subscribe {destination} → register a fanout receiver
 *                           (a gateway shard; maintained on session open)
 *       POST /net/adopt     {from_scope, seq, cells} → CA3 rider
 *                           adoption: install authoritative cells this
 *                           scope anchors that were committed at another
 *                           scope; idempotent by (from_scope, seq)
 *       POST /net/schedule  park a scheduled turn + arm the alarm
 *                           (test-facing until the gateway machinery
 *                           schedules from transcripts)
 *   - the durable fanout outbox (CO2.7): accepted commits enqueue
 *     /net/fanout rows (every subscriber) and /net/adopt rows (every
 *     rider scope) in the SAME transaction as the commit write-through,
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
import { lineageClosureKeys, serializeTransfer, type CellTransfer } from "../../net/cells";
import { isNetError, netError } from "../../net/errors";
import { Outbox, type FanoutBody, type FanoutRow } from "../../net/outbox";
import { ScopeSequencer, type CommitSubmit, type ScheduledTurn, type ScopeHead } from "../../net/scope";
import type { ScopeMeta, ScopeStore, TailEntry } from "../../net/scope-store";
import type { CommitReply } from "../../net/scope";
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

/** The two outbox delivery surfaces. They drain as separate lanes so a
 * destination carrying both cannot collide row ids, and adoption cannot
 * be held behind a slow subscriber (or vice versa). */
type OutboxRoute = "/fanout" | "/adopt";

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
}

const SCOPE_ALARM_KEY = "scope";

export class NetScopeDO {
  private readonly store: SqliteScopeStore;
  private readonly host: WorkerdHost;
  private seq: ScopeSequencer | null = null;
  /** One drain at a time; a re-kick while draining is dropped (the next
   * request or defer re-kicks — rows are durable, nothing is lost). */
  private draining = false;

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
        // {submit, rider_destinations} sibling shape.
        const raw = (await request.json()) as
          | CommitSubmit
          | { submit: CommitSubmit; rider_destinations?: RiderDestinations };
        const submit = "submit" in raw ? raw.submit : raw;
        const riderDestinations = "submit" in raw ? (raw.rider_destinations ?? {}) : {};
        const seq = this.ensureSequencer(submit.scope, submit.stamp.catalog_epoch);
        const headBefore = seq.head().seq;
        let reply!: CommitReply;
        // The commit write-through and the outbox enqueue share ONE
        // transaction (CO2.7: rows are durable before the reply returns;
        // a crash can never separate a commit from its fanout). The
        // sequencer's internal transaction joins this outer one.
        this.store.transaction(() => {
          reply = seq.submit(submit);
          // Idempotent replays (head did not advance) enqueue nothing:
          // their rows were enqueued when the turn first committed.
          if (reply.status === "accepted" && reply.head.seq === headBefore + 1) {
            this.enqueueDeliveries(seq, reply, submit, riderDestinations);
          }
        });
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
        const body = (await request.json()) as { from_scope: string; seq: number; cells: Cell[] };
        return json(this.adopt(body));
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
        seq.seed(body.cells);
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
        seq.schedule(body.turn, this.host.now());
        this.rearmAlarm(seq);
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
   * durable path re-derives everything here. Step 2 only OBSERVES fired
   * turns (a woo.metric line each); planning/submitting the scheduled
   * turn arrives with step-3 gateway machinery. Re-arming from
   * nextAlarmAt() is unconditional: remaining parked turns must wake.
   */
  async alarm(): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null) {
      // Nothing durable names this scope — a spurious wake. Clear.
      await this.state.storage.deleteAlarm();
      return;
    }
    const seq = this.ensureSequencer(meta.scope, meta.catalog_epoch);
    const now = this.host.now();
    for (const turn of seq.dueTurns(now)) {
      console.log(
        "woo.metric",
        JSON.stringify({
          kind: "net_scope_scheduled_turn_fired",
          scope: seq.scope,
          id: turn.id,
          at_logical_time: turn.at_logical_time,
          fired_at: now,
          ts: Date.now()
        })
      );
    }
    this.rearmAlarm(seq);
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
    this.seq = new ScopeSequencer(resolvedScope, resolvedEpoch, { durable: this.store });
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
    for (;;) {
      let added = false;
      for (const need of lineageClosureKeys([...cells.values()])) {
        if (cells.has(need) || knownSet.has(need)) continue;
        const cell = store.get(need);
        if (cell) {
          cells.set(need, cell);
          added = true;
        }
      }
      if (!added) break;
    }
    const transfer = serializeTransfer([...cells.values()].sort((a, b) => a.key.localeCompare(b.key)), knownSet);
    return { ...transfer, scope: seq.scope, head: seq.head(), catalog_epoch: seq.catalogEpoch };
  }

  // ---- Fanout + rider adoption (CO2.7, CA3) ---------------------------

  /**
   * Enqueue the accepted commit's deliveries durably (called inside the
   * submit transaction): a /net/fanout row per registered subscriber
   * (lineage-closed touched closure + the transcript's observations) and
   * a /net/adopt row per rider scope carrying only the cells anchored to
   * it — the gateway's rider_destinations names those objects, because
   * anchor topology is gateway knowledge the sequencer never learns.
   */
  private enqueueDeliveries(
    seq: ScopeSequencer,
    reply: Extract<CommitReply, { status: "accepted" }>,
    submit: CommitSubmit,
    riderDestinations: RiderDestinations
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
          observations
        });
      }
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
      this.persistOutboxRow("/adopt", rider.destination, {
        scope: seq.scope,
        seq: reply.head.seq,
        cells: transfer.cells,
        // Observations fan out to subscribers; adoption is cell-only.
        observations: []
      });
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
      for (const route of ["/fanout", "/adopt"] as const) {
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
        const outbox = new Outbox();
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
              await this.host.rpc(row.destination, "/adopt", {
                from_scope: row.body.scope,
                seq: row.body.seq,
                cells: row.body.cells
              });
            } else {
              await this.host.rpc(row.destination, "/fanout", row.body);
            }
          } catch (err) {
            deliveryErrors.set(row.id, String(err));
            throw err;
          }
        });
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
    } finally {
      this.draining = false;
    }
  }

  /**
   * CA3 rider adoption: install cells this scope anchors that were
   * committed atomically at another scope — the owner adopting the
   * ride-along write as its authority copy (authoritative-into-authority
   * install; the cells keep the committing scope's stamp per CO8). This
   * scope's own head does NOT advance: adoption is not a commit here.
   * Idempotent by (from_scope, seq) high-water, so the at-least-once
   * outbox may redeliver freely.
   */
  private adopt(body: { from_scope: string; seq: number; cells: Cell[] }): { applied: boolean; installed: number } {
    const seq = this.ensureSequencer();
    return this.store.transaction(() => {
      const rows = sqlRows<{ seq: number }>(
        this.state.storage.sql.exec("SELECT seq FROM net_scope_adopted WHERE from_scope = ?", body.from_scope)
      );
      const last = rows.length > 0 ? Number(rows[0].seq) : 0;
      if (body.seq <= last) return { applied: false, installed: 0 };
      for (const cell of body.cells) {
        seq.store.install(cell);
        this.store.writeCell(cell);
      }
      this.state.storage.sql.exec(
        "INSERT INTO net_scope_adopted (from_scope, seq) VALUES (?, ?) ON CONFLICT(from_scope) DO UPDATE SET seq = excluded.seq",
        body.from_scope,
        body.seq
      );
      return { applied: true, installed: body.cells.length };
    });
  }

  /** Always re-derive the wake-up from scope state (never from memory). */
  private rearmAlarm(seq: ScopeSequencer): void {
    this.host.setAlarm(SCOPE_ALARM_KEY, seq.nextAlarmAt(), async () => {
      // The durable wake path is alarm() above; this callback exists to
      // satisfy the Host contract and is not retained by WorkerdHost.
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
