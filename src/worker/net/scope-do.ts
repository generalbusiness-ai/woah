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
 *       POST /net/submit    CommitSubmit → CommitReply
 *       POST /net/closure   {keys, known?} → lineage-closed CellTransfer
 *       GET  /net/head      {scope, catalog_epoch, head}
 *       POST /net/seed      bootstrap/install path (also how tests build
 *                           a scope; the catalog install pipeline adopts
 *                           it in a later step)
 *       POST /net/schedule  park a scheduled turn + arm the alarm
 *                           (test-facing until step-3 gateway machinery
 *                           schedules from transcripts)
 *   - the alarm() wake path: pop due turns, emit a woo.metric line per
 *     fired turn (planning a scheduled turn arrives with step 3), and
 *     ALWAYS re-arm from nextAlarmAt() — the queue is scope state, so a
 *     parked task survives eviction (CO2.8).
 *
 * This class sits beside the v2 DO classes and shares nothing with them:
 * the standing v2 freeze continues, nothing routes production traffic
 * here until Phase 5.
 */
import type { Cell } from "../../net/cells";
import { lineageClosureKeys, serializeTransfer, type CellTransfer } from "../../net/cells";
import { isNetError, netError } from "../../net/errors";
import { ScopeSequencer, type CommitSubmit, type ScheduledTurn, type ScopeHead } from "../../net/scope";
import type { ScopeMeta, ScopeStore, TailEntry } from "../../net/scope-store";
import type { CommitReply } from "../../net/scope";
import { verifyInternalRequest } from "../internal-auth";
import { WorkerdHost, type WorkerdHostEnv } from "./workerd-host";

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

export type NetScopeEnv = WorkerdHostEnv;

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

  constructor(
    private readonly state: NetScopeDurableState,
    private readonly env: NetScopeEnv
  ) {
    this.store = new SqliteScopeStore(state.storage);
    this.host = new WorkerdHost({
      // Step 2: the scope never initiates RPC yet (fanout/adoption drains
      // arrive with step 3's outbox wiring); refuse loudly if reached.
      resolve: (destination) => {
        throw new Error(`NetScopeDO rpc destination not wired until step 3: ${destination}`);
      },
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
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/net/submit") {
        const submit = (await request.json()) as CommitSubmit;
        const seq = this.ensureSequencer(submit.scope, submit.stamp.catalog_epoch);
        return json(seq.submit(submit));
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
