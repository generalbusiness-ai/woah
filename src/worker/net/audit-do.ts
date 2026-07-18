/**
 * NetAuditDO — the audit shard (audit.md AU6.3/AU6.4, AU7).
 *
 * One shard holds a bounded slice of customer partitions (routing:
 * `audit:<auditShardFor(partition, NET_AUDIT_SHARDS)>`). It does three
 * things and holds NO authority (a shard is always rebuildable from
 * undelivered scope lanes plus its own segments):
 *
 * - `/net/audit-append`: idempotent record append — redelivery no-ops on
 *   (partition, idempotency), so the scope outbox's at-least-once
 *   delivery yields exactly-once records;
 * - segment build: appended records flush into IMMUTABLE, hash-chained
 *   segments per partition (each segment cites the previous segment's
 *   hash; the chain head is verifiable end-to-end). Object-storage
 *   offload of sealed segments is the deployed-profile follow-up; the
 *   contract (immutability, chain, bounded hot set) is enforced here.
 * - `/net/audit-query`: bounded, partition-scoped reads for the
 *   customer query surface (AU7 — the GATEWAY enforces which partition
 *   a caller may name; this internal route trusts its signed caller).
 *
 * Layering: a shell like scope-do — internal-auth verified fetch,
 * SQLite via transactionSync, no engine imports.
 */
import { normalizeRoutedAuditRecord, type AuditRecord } from "../../net/audit";
import { cellVersion } from "../../net/cells";
import { netError } from "../../net/errors";
import { verifyInternalRequest } from "../internal-auth";
import { emitMetric, type AnalyticsMetric, type MetricsAnalyticsBinding } from "../metrics-sink";
import type { NetBindingsEnv } from "./workerd-host";

export type NetAuditEnv = NetBindingsEnv & {
  /** Records per partition before a segment seals (bounded hot set). */
  NET_AUDIT_SEGMENT_ROWS?: string;
  METRICS?: MetricsAnalyticsBinding;
};

/** The storage slice this DO needs — satisfied by real DO storage and
 * the fake-DO test harness alike (same shape as NetScopeDurableState). */
export type NetAuditDurableState = {
  id: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): unknown };
    transactionSync<T>(fn: () => T): T;
    setAlarm?: (at: number) => void | Promise<void>;
    deleteAlarm?: () => void | Promise<void>;
  };
};

function sqlRows<T>(cursor: unknown): T[] {
  const result = cursor as { toArray?: () => unknown[] } & Iterable<unknown>;
  if (typeof result.toArray === "function") return result.toArray() as T[];
  return [...result] as T[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type AuditQuery = {
  partition: string;
  from_ts?: number;
  to_ts?: number;
  actor?: string;
  verb?: string;
  target?: string;
  outcome?: string;
  trace_id?: string;
  limit?: number;
};

const QUERY_LIMIT_MAX = 200;
const DEFAULT_SEGMENT_ROWS = 64;

export class NetAuditDO {
  private readonly state: NetAuditDurableState;
  private readonly env: NetAuditEnv;

  constructor(state: NetAuditDurableState, env: NetAuditEnv) {
    this.state = state;
    this.env = env;
    // Hot records: filter columns are extracted at append so queries
    // never JSON-parse the whole partition. segment_id NULL = unsealed.
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_audit_record (partition TEXT NOT NULL, idempotency TEXT NOT NULL, ts INTEGER NOT NULL, actor TEXT, verb TEXT, target TEXT, outcome TEXT NOT NULL, trace_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, segment_id TEXT, PRIMARY KEY (partition, idempotency))"
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_net_audit_record_ts ON net_audit_record (partition, ts)"
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_net_audit_record_unsealed ON net_audit_record (partition, segment_id)"
    );
    // Immutable sealed segments: hash chains per partition. seq is the
    // per-partition segment ordinal; hash covers (prev_hash, records).
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_audit_segment (partition TEXT NOT NULL, seq INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, count INTEGER NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (partition, seq))"
    );
  }

  private metric(event: AnalyticsMetric): void {
    emitMetric(event, `audit-${String(this.state.id)}`, this.env.METRICS);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(this.env, request);
    } catch (err) {
      return json({ error: String(err) }, 401);
    }
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/net/probe") {
        return json({ ok: true, service: "net-audit" });
      }
      if (request.method === "POST" && url.pathname === "/net/audit-append") {
        const body = (await request.json()) as { from_scope?: string; seq?: number; records?: unknown[] };
        const rows = Array.isArray(body.records) ? body.records : [];
        const result = this.state.storage.transactionSync(() => this.append(rows));
        this.metric({
          kind: "net_audit_append",
          scope: typeof body.from_scope === "string" ? body.from_scope : "",
          appended: result.appended,
          duplicate: result.duplicates,
          malformed: result.malformed,
          sealed: result.sealed
        });
        return json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/net/audit-query") {
        const query = (await request.json()) as AuditQuery;
        if (typeof query.partition !== "string" || query.partition.length === 0) {
          throw netError("E_INVARG", "audit-query requires a partition", { field: "partition" });
        }
        return json({ ok: true, records: this.query(query) });
      }
      if (request.method === "POST" && url.pathname === "/net/audit-verify") {
        const body = (await request.json()) as { partition?: unknown };
        if (typeof body.partition !== "string" || body.partition.length === 0) {
          throw netError("E_INVARG", "audit-verify requires a partition", { field: "partition" });
        }
        return json(this.verifyChain(body.partition));
      }
      return json({ error: "unknown audit route" }, 404);
    } catch (err) {
      const status = err && typeof err === "object" && "code" in err && err.code === "E_INVARG" ? 400 : 500;
      return json({ error: String(err) }, status);
    }
  }

  /** Idempotent append + seal-on-threshold. Runs inside transactionSync:
   * records and any sealed segment commit atomically. */
  private append(raw: unknown[]): { appended: number; duplicates: number; malformed: number; sealed: number } {
    let appended = 0;
    let duplicates = 0;
    let malformed = 0;
    const touched = new Set<string>();
    for (const entry of raw) {
      const routed = normalizeRoutedAuditRecord(entry);
      if (routed === null) {
        // A malformed record is counted and dropped — the producer-side
        // mint guard makes this a producer bug signal, never data loss
        // of a well-formed record.
        malformed += 1;
        continue;
      }
      const { partition, record } = routed;
      const before = this.recordExists(partition, record.idempotency);
      if (before) {
        duplicates += 1;
        continue;
      }
      this.state.storage.sql.exec(
        "INSERT INTO net_audit_record (partition, idempotency, ts, actor, verb, target, outcome, trace_id, kind, body, segment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        partition,
        record.idempotency,
        record.ts,
        record.principal?.actor ?? null,
        record.action.verb ?? null,
        record.action.target ?? null,
        record.outcome,
        record.trace_id ?? null,
        record.action.kind,
        JSON.stringify(record)
      );
      appended += 1;
      touched.add(partition);
    }
    let sealed = 0;
    for (const partition of touched) sealed += this.sealIfDue(partition);
    return { appended, duplicates, malformed, sealed };
  }

  private recordExists(partition: string, idempotency: string): boolean {
    const rows = sqlRows<{ n: number }>(
      this.state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM net_audit_record WHERE partition = ? AND idempotency = ?",
        partition,
        idempotency
      )
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** Seal unsealed records into an immutable, hash-chained segment when
   * the partition's unsealed count reaches the threshold. Records stay
   * queryable after sealing (segment_id set); the segment body is the
   * canonical export/verification artifact. */
  private sealIfDue(partition: string): number {
    const threshold = this.segmentRows();
    const unsealed = sqlRows<{ idempotency: string; ts: number; body: string }>(
      this.state.storage.sql.exec(
        "SELECT idempotency, ts, body FROM net_audit_record WHERE partition = ? AND segment_id IS NULL ORDER BY ts, idempotency",
        partition
      )
    );
    if (unsealed.length < threshold) return 0;
    const head = sqlRows<{ seq: number; hash: string }>(
      this.state.storage.sql.exec(
        "SELECT seq, hash FROM net_audit_segment WHERE partition = ? ORDER BY seq DESC LIMIT 1",
        partition
      )
    );
    const prevSeq = head.length > 0 ? Number(head[0].seq) : 0;
    const prevHash = head.length > 0 ? String(head[0].hash) : "genesis";
    const records = unsealed.map((row) => JSON.parse(row.body) as AuditRecord);
    const hash = cellVersion([prevHash, records.map((r) => r.idempotency), cellVersion(records)]);
    const seq = prevSeq + 1;
    const segmentId = `${partition}:${seq}`;
    this.state.storage.sql.exec(
      "INSERT INTO net_audit_segment (partition, seq, prev_hash, hash, count, from_ts, to_ts, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      partition,
      seq,
      prevHash,
      hash,
      records.length,
      unsealed[0].ts,
      unsealed[unsealed.length - 1].ts,
      JSON.stringify(records)
    );
    for (const row of unsealed) {
      this.state.storage.sql.exec(
        "UPDATE net_audit_record SET segment_id = ? WHERE partition = ? AND idempotency = ?",
        segmentId,
        partition,
        row.idempotency
      );
    }
    return 1;
  }

  private segmentRows(): number {
    const configured = Number(this.env.NET_AUDIT_SEGMENT_ROWS);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SEGMENT_ROWS;
    return Math.max(2, Math.floor(configured));
  }

  /** Bounded partition-scoped query, newest first (AU7). */
  private query(query: AuditQuery): AuditRecord[] {
    const clauses: string[] = ["partition = ?"];
    const bindings: unknown[] = [query.partition];
    const optional: Array<[keyof AuditQuery, string]> = [
      ["actor", "actor = ?"],
      ["verb", "verb = ?"],
      ["target", "target = ?"],
      ["outcome", "outcome = ?"],
      ["trace_id", "trace_id = ?"]
    ];
    for (const [field, clause] of optional) {
      const value = query[field];
      if (typeof value === "string" && value.length > 0) {
        clauses.push(clause);
        bindings.push(value);
      }
    }
    if (typeof query.from_ts === "number" && Number.isFinite(query.from_ts)) {
      clauses.push("ts >= ?");
      bindings.push(query.from_ts);
    }
    if (typeof query.to_ts === "number" && Number.isFinite(query.to_ts)) {
      clauses.push("ts <= ?");
      bindings.push(query.to_ts);
    }
    const limit = Math.min(
      QUERY_LIMIT_MAX,
      typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
        ? Math.floor(query.limit)
        : 50
    );
    const rows = sqlRows<{ body: string }>(
      this.state.storage.sql.exec(
        `SELECT body FROM net_audit_record WHERE ${clauses.join(" AND ")} ORDER BY ts DESC, idempotency DESC LIMIT ${limit}`,
        ...bindings
      )
    );
    return rows.map((row) => JSON.parse(row.body) as AuditRecord);
  }

  /** AU7/AU10.4: walk the partition's segment chain and re-derive every
   * hash. Verifiability is the product feature — the trail is evidence. */
  private verifyChain(partition: string): { ok: boolean; segments: number; broken_at?: number } {
    const segments = sqlRows<{ seq: number; prev_hash: string; hash: string; body: string }>(
      this.state.storage.sql.exec(
        "SELECT seq, prev_hash, hash, body FROM net_audit_segment WHERE partition = ? ORDER BY seq",
        partition
      )
    );
    let prev = "genesis";
    for (const segment of segments) {
      const records = JSON.parse(segment.body) as AuditRecord[];
      const expected = cellVersion([prev, records.map((r) => r.idempotency), cellVersion(records)]);
      if (segment.prev_hash !== prev || segment.hash !== expected) {
        return { ok: false, segments: segments.length, broken_at: Number(segment.seq) };
      }
      prev = segment.hash;
    }
    return { ok: true, segments: segments.length };
  }
}
